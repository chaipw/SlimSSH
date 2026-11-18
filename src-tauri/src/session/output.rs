use std::{cmp, collections::VecDeque};

pub(super) const FLUSH_BYTES: usize = 64 * 1024;
pub(super) const MAX_PENDING_BYTES: usize = 1024 * 1024;
pub(super) const MAX_UNACKED_BYTES: usize = 256 * 1024;
pub(super) const MAX_SSH_PACKET_BYTES: usize = 32 * 1024;

#[derive(Debug, Eq, PartialEq)]
pub(super) struct OutputChunk {
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Debug)]
struct SentChunk {
    seq: u64,
    len: usize,
}

#[derive(Debug)]
pub(super) struct OutputBuffer {
    pending: VecDeque<u8>,
    sent: VecDeque<SentChunk>,
    next_seq: u64,
    acked_through: u64,
    unacked_bytes: usize,
}

impl OutputBuffer {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            sent: VecDeque::new(),
            next_seq: 1,
            acked_through: 0,
            unacked_bytes: 0,
        }
    }

    pub fn can_read(&self) -> bool {
        self.pending.len().saturating_add(MAX_SSH_PACKET_BYTES) <= MAX_PENDING_BYTES
            && self.unacked_bytes < MAX_UNACKED_BYTES
    }

    pub fn push(&mut self, data: &[u8]) -> bool {
        if self.pending.len().saturating_add(data.len()) > MAX_PENDING_BYTES {
            return false;
        }
        self.pending.extend(data);
        true
    }

    pub fn flush(&mut self, force: bool) -> Vec<OutputChunk> {
        let mut chunks = Vec::new();
        while !self.pending.is_empty()
            && self.unacked_bytes < MAX_UNACKED_BYTES
            && (force || self.pending.len() >= FLUSH_BYTES)
        {
            let credit = MAX_UNACKED_BYTES - self.unacked_bytes;
            let len = cmp::min(cmp::min(self.pending.len(), FLUSH_BYTES), credit);
            let data = self.pending.drain(..len).collect::<Vec<_>>();
            let seq = self.next_seq;
            self.next_seq = self.next_seq.saturating_add(1);
            self.sent.push_back(SentChunk { seq, len });
            self.unacked_bytes += len;
            chunks.push(OutputChunk { seq, data });
        }
        chunks
    }

    pub fn ack(&mut self, seq: u64) -> bool {
        if seq == 0 || seq >= self.next_seq {
            return false;
        }
        if seq <= self.acked_through {
            return true;
        }
        self.acked_through = seq;
        while self.sent.front().is_some_and(|chunk| chunk.seq <= seq) {
            if let Some(chunk) = self.sent.pop_front() {
                self.unacked_bytes = self.unacked_bytes.saturating_sub(chunk.len);
            }
        }
        true
    }

    pub fn pending_is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    #[cfg(test)]
    fn unacked_bytes(&self) -> usize {
        self.unacked_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregation_waits_for_threshold_or_force() {
        let mut output = OutputBuffer::new();
        assert!(output.push(&vec![1; 100]));
        assert!(output.flush(false).is_empty());
        let chunks = output.flush(true);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].seq, 1);
        assert_eq!(chunks[0].data.len(), 100);
    }

    #[test]
    fn unacked_limit_is_never_exceeded() {
        let mut output = OutputBuffer::new();
        assert!(output.push(&vec![7; MAX_UNACKED_BYTES + 1000]));
        let chunks = output.flush(true);
        assert_eq!(output.unacked_bytes(), MAX_UNACKED_BYTES);
        assert_eq!(
            chunks.iter().map(|chunk| chunk.data.len()).sum::<usize>(),
            MAX_UNACKED_BYTES
        );
        assert_eq!(chunks.last().unwrap().data.len(), FLUSH_BYTES);
        assert!(!output.can_read());
        assert!(output.ack(chunks.last().unwrap().seq));
        assert_eq!(output.unacked_bytes(), 0);
        assert_eq!(output.flush(true)[0].data.len(), 1000);
    }

    #[test]
    fn later_ack_confirms_earlier_chunks() {
        let mut output = OutputBuffer::new();
        assert!(output.push(&vec![0; FLUSH_BYTES * 2]));
        let chunks = output.flush(false);
        assert_eq!(chunks.len(), 2);
        assert!(output.ack(2));
        assert_eq!(output.unacked_bytes(), 0);
        assert!(output.ack(1));
        assert!(!output.ack(3));
    }
}
