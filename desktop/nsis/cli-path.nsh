!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro AmpleFileCliBroadcastEnvironment
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro AmpleFileCliManageUserPath ACTION
  Push $0
  Push $1
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\bin\amplefile-cli.ps1" --amplefile-installer-manage-user-path ${ACTION} "$INSTDIR\bin"`
  Pop $0
  Pop $1
  ${If} $0 == 0
    !insertmacro AmpleFileCliBroadcastEnvironment
  ${Else}
    DetailPrint "AmpleFile CLI user PATH ${ACTION} failed: $1"
    SetErrors
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !insertmacro AmpleFileCliManageUserPath "install"
!macroend

!macro customUnInstall
  !insertmacro AmpleFileCliManageUserPath "uninstall"
!macroend
