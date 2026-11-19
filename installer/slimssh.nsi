Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!define APP_NAME "SlimSSH"
!define APP_VERSION "0.1.3"
!define APP_EXE "SlimSSH.exe"
!define APP_PUBLISHER "SlimSSH"
!define APP_ID "SlimSSH"
!ifndef APP_BINARY
  !define APP_BINARY "..\src-tauri\target\release\slimssh.exe"
!endif
!ifndef INSTALLER_OUTPUT
  !define INSTALLER_OUTPUT "SlimSSH-Setup-${APP_VERSION}.exe"
!endif

Name "${APP_NAME}"
OutFile "${INSTALLER_OUTPUT}"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "Software\${APP_ID}" "InstallDir"
!ifdef SLIMSSH_INSTALLER_TEST
  RequestExecutionLevel user
!else
  RequestExecutionLevel admin
!endif
SetCompressor /SOLID lzma

VIProductVersion "0.1.3.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 SlimSSH contributors"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE CheckExistingVersion
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetRegView 64
!ifndef SLIMSSH_INSTALLER_TEST
  ; Preserve an explicit command-line /D= directory over the registry default.
  ClearErrors
  ${GetOptions} "$CMDLINE" "/D=" $0
  IfErrors 0 init_done
  ReadRegStr $0 HKLM "Software\${APP_ID}" "InstallDir"
  StrCmp $0 "" +2
    StrCpy $INSTDIR $0
init_done:
!endif
FunctionEnd

Var ExistingVersion
Var HasUpgradeBackup

; Check the selected directory on leaving the directory page, and again in the
; install section so silent installs and late changes receive the same checks.
Function CheckExistingVersion
  IfFileExists "$INSTDIR\${APP_EXE}" 0 allowed
  ClearErrors
  ${GetFileVersion} "$INSTDIR\${APP_EXE}" $ExistingVersion
  IfErrors unknown_version
  StrCmp $ExistingVersion "" unknown_version
  ${VersionCompare} "$ExistingVersion" "${APP_VERSION}" $0
  StrCmp $0 0 same_version
  StrCmp $0 1 newer_version
  DetailPrint "检测到旧版本 $ExistingVersion，将升级到 ${APP_VERSION}。"
  Goto allowed
same_version:
  SetErrorLevel 1638
  MessageBox MB_OK|MB_ICONINFORMATION "此目录已安装 SlimSSH $ExistingVersion，与安装包版本 ${APP_VERSION} 相同，无需重复安装。$\r$\n$\r$\n安装目录：$INSTDIR" /SD IDOK
  Abort "同版本，无需重复安装。"
newer_version:
  SetErrorLevel 1638
  MessageBox MB_OK|MB_ICONEXCLAMATION "此目录已安装较新版本 SlimSSH $ExistingVersion。$\r$\n当前安装包版本为 ${APP_VERSION}，已阻止覆盖较新版本。$\r$\n$\r$\n安装目录：$INSTDIR" /SD IDOK
  Abort "已安装较新版本，停止安装。"
unknown_version:
  SetErrorLevel 13
  MessageBox MB_OK|MB_ICONEXCLAMATION "无法读取此目录中 ${APP_EXE} 的版本，为避免覆盖未知文件，已停止安装。$\r$\n$\r$\n请选择其他目录，或确认该文件后手动处理。$\r$\n$INSTDIR" /SD IDOK
  Abort "无法确定已有程序版本。"
allowed:
  SetErrorLevel 0
FunctionEnd

Function InstallExecutable
  StrCpy $HasUpgradeBackup 0
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors install_failed
  ; Never overwrite a backup left by an interrupted or failed upgrade.
  IfFileExists "$INSTDIR\${APP_EXE}.upgrade-backup" backup_exists
  IfFileExists "$INSTDIR\${APP_EXE}" 0 install_new
  System::Call 'kernel32::CopyFileW(w "$INSTDIR\${APP_EXE}", w "$INSTDIR\${APP_EXE}.upgrade-backup", i 1) i .r0'
  StrCmp $0 0 install_failed
  StrCpy $HasUpgradeBackup 1
retry_delete:
  ClearErrors
  Delete "$INSTDIR\${APP_EXE}"
  IfErrors delete_failed install_new
delete_failed:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无法删除旧版 SlimSSH，程序可能正在运行。$\r$\n请关闭该安装目录中的 SlimSSH 后点击“重试”，或取消安装。$\r$\n$INSTDIR" /SD IDCANCEL IDRETRY retry_delete
  Delete "$INSTDIR\${APP_EXE}.upgrade-backup"
  SetErrorLevel 5
  Abort "旧版程序仍在使用，未升级。"
install_new:
!ifdef SLIMSSH_TEST_FAIL_COPY
  Goto copy_failed
!endif
  System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\SlimSSH.payload.exe", w "$INSTDIR\${APP_EXE}", i 1) i .r0'
  StrCmp $0 0 copy_failed
  StrCmp $HasUpgradeBackup 1 0 done
  Delete "$INSTDIR\${APP_EXE}.upgrade-backup"
  Goto done
copy_failed:
  StrCmp $HasUpgradeBackup 1 0 install_failed
  System::Call 'kernel32::CopyFileW(w "$INSTDIR\${APP_EXE}.upgrade-backup", w "$INSTDIR\${APP_EXE}", i 0) i .r0'
  StrCmp $0 0 restore_failed
  Delete "$INSTDIR\${APP_EXE}.upgrade-backup"
  SetErrorLevel 5
  MessageBox MB_OK|MB_ICONSTOP "新版本安装失败，已恢复旧版 SlimSSH。请检查磁盘空间和目录权限后重试。" /SD IDOK
  Abort "安装失败，已恢复旧版本。"
restore_failed:
  SetErrorLevel 5
  MessageBox MB_OK|MB_ICONSTOP "安装失败，旧程序备份仍保存在：$\r$\n$INSTDIR\${APP_EXE}.upgrade-backup$\r$\n请保留该文件并手动恢复。" /SD IDOK
  Abort "安装失败，请保留旧程序备份。"
backup_exists:
  SetErrorLevel 5
  MessageBox MB_OK|MB_ICONEXCLAMATION "发现上次升级留下的备份，已停止安装以免覆盖：$\r$\n$INSTDIR\${APP_EXE}.upgrade-backup$\r$\n请先确认并处理此备份后重试。" /SD IDOK
  Abort "已有升级备份，停止安装。"
install_failed:
  SetErrorLevel 5
  MessageBox MB_OK|MB_ICONSTOP "无法安装 SlimSSH。旧程序未被删除，请检查安装目录权限和磁盘空间。$\r$\n$INSTDIR" /SD IDOK
  Abort "无法写入安装目录。"
done:
  SetErrorLevel 0
FunctionEnd

Section "SlimSSH"
  Call CheckExistingVersion
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=SlimSSH.payload.exe" "${APP_BINARY}"
  Call InstallExecutable
  SetOutPath "$INSTDIR"

  WriteUninstaller "$INSTDIR\uninstall.exe"

!ifndef SLIMSSH_INSTALLER_TEST
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall SlimSSH.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKLM "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1
!endif
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

!ifndef SLIMSSH_INSTALLER_TEST
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall SlimSSH.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKLM "Software\${APP_ID}"
!endif
SectionEnd
