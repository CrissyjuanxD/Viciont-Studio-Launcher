; Viciont Studio Launcher — pasos extra del instalador / desinstalador (NSIS)
;
; Al desinstalar se pregunta qué hacer con los datos:
;   - Conservar instancias, mundos, cuentas y skins (para reinstalar más tarde)
;   - Borrar todo (instancias, mundos, cuentas, skins, Java y caché)
; Las actualizaciones automáticas NUNCA borran datos.

!ifdef BUILD_UNINSTALLER
!include nsDialogs.nsh
!include LogicLib.nsh

Var vslDeleteAll
Var vslRadioKeep
Var vslRadioAll

; Se inserta donde se definen las páginas del desinstalador (con MUI ya cargado).
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
    ${NSD_CreateLabel} 0 0 100% 34u "Viciont Studio Launcher guarda en tu PC las instancias (mods, mundos, configuraciones), tus cuentas, tus skins y el Java de Minecraft."
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
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Se borrarán tus instancias y mundos de Viciont Studio Launcher. ¿Seguro?" IDYES +2
      Abort
      StrCpy $vslDeleteAll "1"
    ${Else}
      StrCpy $vslDeleteAll "0"
    ${EndIf}
  FunctionEnd
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; los datos del launcher siempre son del usuario actual
    SetShellVarContext current
    ReadRegStr $1 HKCU "Software\ViciontStudioLauncher" "DataDir"
    ${If} $vslDeleteAll == "1"
      ; solo se borra la carpeta de datos si es realmente del launcher (tiene la marca .vsl-data)
      ${If} $1 != ""
      ${AndIf} ${FileExists} "$1\.vsl-data"
        RMDir /r "$1"
      ${EndIf}
      RMDir /r "$APPDATA\ViciontStudioLauncher"
      DeleteRegKey HKCU "Software\ViciontStudioLauncher"
    ${Else}
      ; se conserva todo lo importante; solo se limpian cachés
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
