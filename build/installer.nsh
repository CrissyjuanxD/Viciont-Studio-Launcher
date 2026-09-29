!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include StrContains.nsh

!define VSL_ART "${__FILEDIR__}"
!define MUI_BGCOLOR 0B0414
!define MUI_TEXTCOLOR F7F2FF
!define MUI_CUSTOMFUNCTION_GUIINIT vslGuiInit
!define MUI_WELCOMEPAGE_TITLE "Bienvenido a Viciont Studios Launcher"
!define MUI_WELCOMEPAGE_TEXT "Vas a instalar el launcher oficial de Viciont Studios para jugar sus eventos, servidores e instancias.$\r$\n$\r$\nPulsa Siguiente para continuar."
!define MUI_FINISHPAGE_TITLE "¡Todo listo!"
!define MUI_FINISHPAGE_TEXT "Viciont Studios Launcher ya está instalado. Lo encontrarás en el escritorio y en el menú Inicio."
!define VSL_RUN_TEXT "Abrir Viciont Studios Launcher"
!define MUI_FINISHPAGE_RUN_TEXT "${VSL_RUN_TEXT}"

Var vslUpdateUI
Var vslDirEdit
Var vslRunLabel

!macro customInit
  StrCpy $vslUpdateUI "0"
  ${if} ${Silent}
  ${andIf} ${isUpdated}
  ${andIf} ${isForceRun}
    SetSilent normal
    StrCpy $vslUpdateUI "1"
  ${endIf}
!macroend

!macro customInstallMode
  ${if} $hasPerMachineInstallation == "1"
    StrCpy $isForceMachineInstall "1"
  ${else}
    StrCpy $isForceCurrentInstall "1"
  ${endIf}
!macroend

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE vslWelcomePre
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom vslDirPage vslDirLeave
  !define MUI_PAGE_HEADER_TEXT "Instalando"
  !define MUI_PAGE_HEADER_SUBTEXT "Espera un momento mientras se instala Viciont Studios Launcher."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW vslInstShow
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION vslStartApp
  !define MUI_PAGE_CUSTOMFUNCTION_PRE vslFinishPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW vslFinishShow
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customHeader
  Function vslDark
    System::Call 'uxtheme::SetWindowTheme(p R0, w "DarkMode_Explorer", p 0)'
  FunctionEnd

  Function vslGreenBar
    System::Call 'uxtheme::SetWindowTheme(p R0, w " ", w " ")'
    System::Call 'user32::GetWindowLongW(p R0, i -20)i.R1'
    IntOp $R1 $R1 & 0xFFFDFDFF
    System::Call 'user32::SetWindowLongW(p R0, i -20, i R1)'
    System::Call 'user32::GetWindowLongW(p R0, i -16)i.R1'
    IntOp $R1 $R1 & 0xFF7FFFFF
    IntOp $R1 $R1 | 0x1
    System::Call 'user32::SetWindowLongW(p R0, i -16, i R1)'
    System::Call 'user32::SetWindowPos(p R0, p 0, i 0, i 0, i 0, i 0, i 0x27)'
    SendMessage $R0 0x0409 0 0x005EC522
    SendMessage $R0 0x2001 0 0x0030101D
  FunctionEnd

  Function vslGuiInit
    InitPluginsDir
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x0014040B, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00FFF2F7, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i 0x00F755A8, i 4)'
    SetCtlColors $HWNDPARENT 0xCFC2E8 0x0B0414
    SetCtlColors $mui.Branding.Background 0x6E5F8C 0x0B0414
    SetCtlColors $mui.Branding.Text 0x6E5F8C 0x0B0414
    ShowWindow $mui.Line.Standard ${SW_HIDE}
    ShowWindow $mui.Line.FullWindow ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 1036
    ShowWindow $0 ${SW_HIDE}
    StrCpy $R0 $mui.Button.Next
    Call vslDark
    StrCpy $R0 $mui.Button.Back
    Call vslDark
    StrCpy $R0 $mui.Button.Cancel
    Call vslDark
    ${if} $vslUpdateUI == "1"
      Call vslUpdateFrame
    ${endIf}
  FunctionEnd

  Function vslUpdateFrame
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Actualizando Viciont Studios Launcher"
    ShowWindow $mui.Header.Text ${SW_HIDE}
    ShowWindow $mui.Header.SubText ${SW_HIDE}
    ShowWindow $mui.Header.Background ${SW_HIDE}
    ShowWindow $mui.Header.Image ${SW_HIDE}
    ShowWindow $mui.Branding.Text ${SW_HIDE}
    ShowWindow $mui.Branding.Background ${SW_HIDE}
    ShowWindow $mui.Button.Next ${SW_HIDE}
    ShowWindow $mui.Button.Back ${SW_HIDE}
    ShowWindow $mui.Button.Cancel ${SW_HIDE}
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16)i.r0'
    IntOp $0 $0 & 0xFF30FFFF
    IntOp $0 $0 | 0x80000000
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
    IntOp $0 $0 & 0xFFFFFCFE
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
    System::Call 'user32::GetSystemMetrics(i 0)i.r1'
    System::Call 'user32::GetSystemMetrics(i 1)i.r2'
    IntOp $1 $1 - 460
    IntOp $1 $1 / 2
    IntOp $2 $2 - 260
    IntOp $2 $2 / 2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i 460, i 260, i 0x24)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
  FunctionEnd

  Function vslWelcomePre
    ${if} ${isUpdated}
    ${orIf} ${UAC_IsInnerInstance}
      Abort
    ${endIf}
  FunctionEnd

  Function vslDirPage
    ${if} ${isUpdated}
      Abort
    ${endIf}
    !insertmacro MUI_HEADER_TEXT "Carpeta de instalación" "Elige dónde instalar Viciont Studios Launcher."
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endIf}
    SetCtlColors $0 0xF7F2FF 0x0B0414
    ${NSD_CreateLabel} 0 4u 100% 12u "Se instalará en esta carpeta:"
    Pop $1
    SetCtlColors $1 0xCFC2E8 0x0B0414
    ${NSD_CreateText} 0 20u 238u 14u "$INSTDIR"
    Pop $vslDirEdit
    SetCtlColors $vslDirEdit 0xF7F2FF 0x160A26
    System::Call 'uxtheme::SetWindowTheme(p $vslDirEdit, w "DarkMode_CFD", p 0)'
    ${NSD_CreateButton} 244u 19u 56u 16u "Cambiar…"
    Pop $1
    StrCpy $R0 $1
    Call vslDark
    ${NSD_OnClick} $1 vslDirBrowse
    ${NSD_CreateLabel} 0 50u 100% 40u "Tus instancias, mundos y cuentas no se guardan aquí: van a la carpeta de datos del launcher, que puedes cambiar cuando quieras desde Ajustes → Almacenamiento."
    Pop $1
    SetCtlColors $1 0x9B8CBA 0x0B0414
    nsDialogs::Show
  FunctionEnd

  Function vslDirBrowse
    Pop $0
    ${NSD_GetText} $vslDirEdit $1
    nsDialogs::SelectFolderDialog "Elige dónde instalar Viciont Studios Launcher" "$1"
    Pop $1
    ${if} $1 != error
      ${NSD_SetText} $vslDirEdit "$1"
    ${endIf}
  FunctionEnd

  Function vslDirLeave
    ${NSD_GetText} $vslDirEdit $0
    ${if} $0 == ""
      MessageBox MB_ICONEXCLAMATION "Elige una carpeta para instalar el launcher."
      Abort
    ${endIf}
    StrCpy $INSTDIR $0
    ${StrContains} $1 "${APP_FILENAME}" $INSTDIR
    ${if} $1 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${endIf}
  FunctionEnd

  Function vslInstShow
    SetCtlColors $mui.InstFilesPage 0xF7F2FF 0x0B0414
    SetCtlColors $mui.InstFilesPage.Text 0xCFC2E8 0x0B0414
    StrCpy $R0 $mui.InstFilesPage.ProgressBar
    Call vslGreenBar
    ${if} $vslUpdateUI == "1"
      ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}
      ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
      ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
      System::Call 'user32::SetWindowPos(p $mui.InstFilesPage, p 0, i 0, i 0, i 460, i 260, i 0x14)'
      File "/oname=$PLUGINSDIR\vslUpdate.bmp" "${VSL_ART}\installerUpdate.bmp"
      System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\vslUpdate.bmp", i 0, i 0, i 0, i 0x10)p.r1'
      System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x5400000E, i 0, i 0, i 460, i 260, p $mui.InstFilesPage, p 0, p 0, p 0)p.r2'
      SendMessage $2 0x0172 0 $1
      System::Call 'user32::SetWindowPos(p r2, p 1, i 0, i 0, i 0, i 0, i 0x13)'
      System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.ProgressBar, p 0, i 60, i 196, i 340, i 8, i 0x14)'
    ${endIf}
  FunctionEnd

  Function vslFinishPre
    ${if} ${isUpdated}
      HideWindow
      Call vslStartApp
      Abort
    ${endIf}
  FunctionEnd

  Function vslFinishShow
    StrCpy $R0 $mui.FinishPage.Run
    Call vslDark
    System::Call '*(i,i,i,i)p.r1'
    System::Call 'user32::GetWindowRect(p $mui.FinishPage.Run, p r1)'
    System::Call 'user32::MapWindowPoints(p 0, p $mui.FinishPage, p r1, i 2)'
    System::Call '*$1(i.r2,i.r3,i.r4,i.r5)'
    System::Free $1
    IntOp $6 $5 - $3
    System::Call 'user32::SetWindowPos(p $mui.FinishPage.Run, p 0, i 0, i 0, i 18, i r6, i 0x16)'
    SendMessage $mui.FinishPage.Run ${WM_SETTEXT} 0 "STR:"
    IntOp $7 $2 + 22
    IntOp $8 $4 - $7
    ${NSD_CreateLabel} $7 $3 $8 $6 "${VSL_RUN_TEXT}"
    Pop $vslRunLabel
    SetCtlColors $vslRunLabel 0xF7F2FF 0x0B0414
    ${NSD_OnClick} $vslRunLabel vslRunToggle
  FunctionEnd

  Function vslRunToggle
    Pop $0
    ${NSD_GetState} $mui.FinishPage.Run $0
    ${if} $0 == ${BST_CHECKED}
      ${NSD_Uncheck} $mui.FinishPage.Run
    ${else}
      ${NSD_Check} $mui.FinishPage.Run
    ${endIf}
  FunctionEnd

  Function vslStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
!macroend
!endif

!ifdef BUILD_UNINSTALLER
!include nsDialogs.nsh
!include LogicLib.nsh

!ifdef MUI_HEADERIMAGE
  !undef MUI_HEADERIMAGE
!endif
!ifdef MUI_HEADERIMAGE_RIGHT
  !undef MUI_HEADERIMAGE_RIGHT
!endif
!ifdef MUI_HEADERIMAGE_BITMAP
  !undef MUI_HEADERIMAGE_BITMAP
!endif

Var vslDeleteAll
Var vslRadioKeep
Var vslRadioAll

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.vslDataPage un.vslDataPageLeave

  Function un.vslDataPage
    StrCpy $vslDeleteAll "0"
    !insertmacro MUI_HEADER_TEXT "¿Qué hacemos con tus datos?" "Elige si quieres conservar tus instancias y mundos."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 34u "Viciont Studios Launcher guarda en tu PC las instancias (mods, mundos, configuraciones), tus cuentas, tus skins y el Java de Minecraft."
    Pop $0
    ${NSD_CreateRadioButton} 0 42u 100% 16u "Conservar mis instancias, mundos y cuentas (recomendado si vas a reinstalar)"
    Pop $vslRadioKeep
    ${NSD_CreateRadioButton} 0 64u 100% 16u "Borrar todo: instancias, mundos, cuentas, skins, Java y caché"
    Pop $vslRadioAll
    ${NSD_CreateLabel} 0 92u 100% 30u "Si eliges borrar todo, no se puede deshacer. Haz una copia de tus mundos antes si los quieres guardar."
    Pop $0
    ${NSD_Check} $vslRadioKeep
    nsDialogs::Show
  FunctionEnd

  Function un.vslDataPageLeave
    ${NSD_GetState} $vslRadioAll $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Se borrarán tus instancias y mundos de Viciont Studios Launcher. ¿Seguro?" IDYES +2
      Abort
      StrCpy $vslDeleteAll "1"
    ${Else}
      StrCpy $vslDeleteAll "0"
    ${EndIf}
  FunctionEnd
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    ReadRegStr $1 HKCU "Software\ViciontStudioLauncher" "DataDir"
    ${If} $vslDeleteAll == "1"
      ${If} $1 != ""
      ${AndIf} ${FileExists} "$1\.vsl-data"
        RMDir /r "$1"
      ${EndIf}
      RMDir /r "$APPDATA\ViciontStudioLauncher"
      DeleteRegKey HKCU "Software\ViciontStudioLauncher"
    ${Else}
      RMDir /r "$APPDATA\ViciontStudioLauncher\electron"
      RMDir /r "$APPDATA\ViciontStudioLauncher\caches"
      ${If} $1 != ""
      ${AndIf} ${FileExists} "$1\.vsl-data"
        RMDir /r "$1\caches"
      ${EndIf}
    ${EndIf}
    RMDir /r "$LOCALAPPDATA\viciont-studio-launcher-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
!endif
