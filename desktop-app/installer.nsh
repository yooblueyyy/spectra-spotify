; Spectra uninstaller: before removing files, put Spotify's shortcuts and
; registry entries back the way they were (they point at Spectra while it's installed).
; Skipped when the uninstaller runs as part of an update (electron-builder passes --updated).
!include "FileFunc.nsh"

!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    IfFileExists "$INSTDIR\Spectra.exe" 0 +2
      ExecWait '"$INSTDIR\Spectra.exe" --restore-launchers'
  ${EndIf}
!macroend
