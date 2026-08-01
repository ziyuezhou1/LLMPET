!macro customInstall
  DetailPrint "Installing LLMPET terminal focus broker..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\backend\install-terminal-focus-broker.ps1" -Mode install -InstallRoot "$INSTDIR\resources\app"'
  Pop $0
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "LLMPET could not install the terminal focus broker (exit code $0)."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing LLMPET terminal focus broker..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\backend\install-terminal-focus-broker.ps1" -Mode uninstall'
  Pop $0
!macroend
