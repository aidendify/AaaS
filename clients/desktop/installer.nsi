Unicode true
!include "MUI2.nsh"
Name "AaaS"
OutFile "dist/AaaS-Setup-1.1.0.exe"
InstallDir "$LOCALAPPDATA\AaaS"
RequestExecutionLevel user
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetOutPath "$INSTDIR"
  File /r "dist/win-unpacked/*.*"
  CreateShortcut "$DESKTOP\AaaS.lnk" "$INSTDIR\AaaS.exe"
  CreateDirectory "$SMPROGRAMS\AaaS"
  CreateShortcut "$SMPROGRAMS\AaaS\AaaS.lnk" "$INSTDIR\AaaS.exe"
  CreateShortcut "$SMPROGRAMS\AaaS\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$DESKTOP\AaaS.lnk"
  Delete "$SMPROGRAMS\AaaS\AaaS.lnk"
  Delete "$SMPROGRAMS\AaaS\Uninstall.lnk"
  RMDir "$SMPROGRAMS\AaaS"
  RMDir /r "$INSTDIR"
SectionEnd
