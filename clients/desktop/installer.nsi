Unicode true
!include "MUI2.nsh"
Name "AIdentify"
OutFile "dist/AIdentify-Setup-1.1.0.exe"
InstallDir "$LOCALAPPDATA\AIdentify"
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
  CreateShortcut "$DESKTOP\AIdentify.lnk" "$INSTDIR\AIdentify.exe"
  CreateDirectory "$SMPROGRAMS\AIdentify"
  CreateShortcut "$SMPROGRAMS\AIdentify\AIdentify.lnk" "$INSTDIR\AIdentify.exe"
  CreateShortcut "$SMPROGRAMS\AIdentify\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$DESKTOP\AIdentify.lnk"
  Delete "$SMPROGRAMS\AIdentify\AIdentify.lnk"
  Delete "$SMPROGRAMS\AIdentify\Uninstall.lnk"
  RMDir "$SMPROGRAMS\AIdentify"
  RMDir /r "$INSTDIR"
SectionEnd
