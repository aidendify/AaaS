Unicode true
!include "MUI2.nsh"
Name "AgentSphere"
OutFile "dist/AgentSphere-Setup-1.1.0.exe"
InstallDir "$LOCALAPPDATA\AgentSphere"
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
  CreateShortcut "$DESKTOP\AgentSphere.lnk" "$INSTDIR\AgentSphere.exe"
  CreateDirectory "$SMPROGRAMS\AgentSphere"
  CreateShortcut "$SMPROGRAMS\AgentSphere\AgentSphere.lnk" "$INSTDIR\AgentSphere.exe"
  CreateShortcut "$SMPROGRAMS\AgentSphere\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$DESKTOP\AgentSphere.lnk"
  Delete "$SMPROGRAMS\AgentSphere\AgentSphere.lnk"
  Delete "$SMPROGRAMS\AgentSphere\Uninstall.lnk"
  RMDir "$SMPROGRAMS\AgentSphere"
  RMDir /r "$INSTDIR"
SectionEnd
