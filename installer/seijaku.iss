; Seijaku's Windows installer (Inno Setup 6).
;
;   iscc /DAppVersion=<version> /DAppDir=..\out\seijaku /DOutDir=..\release installer\seijaku.iss
;
; Installs the packaged app (scripts/build/package.ps1) for the current
; user only, into %LOCALAPPDATA%\Programs\Seijaku. No admin rights, no
; Firefox, and nothing else to install first: the engine is inside the
; package, renamed to seijaku.exe, so it needs nothing else at all.
; The profile lives in %APPDATA%\Seijaku, so the install folder stays
; read-only and updates keep your tabs.
;
; This runs in the Release workflow, not on your computer.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppDir
  #define AppDir "..\out\seijaku"
#endif
#ifndef OutDir
  #define OutDir "..\release"
#endif

[Setup]
AppId={{3B84B47F-E97E-4C90-AC83-37273A1DF910}
AppName=Seijaku
AppVersion={#AppVersion}
AppVerName=Seijaku {#AppVersion}
AppPublisher=Seijaku
AppPublisherURL=https://github.com/tacobellerontop-sudo/seijaku_
AppSupportURL=https://github.com/tacobellerontop-sudo/seijaku_/issues
DefaultDirName={localappdata}\Programs\Seijaku
DefaultGroupName=Seijaku
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=SeijakuSetup-{#AppVersion}
SetupIconFile={#AppDir}\seijaku.ico
UninstallDisplayIcon={app}\seijaku.ico
UninstallDisplayName=Seijaku
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=yes
ChangesAssociations=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
; The portable start script and profile folder aren't part of an install.
Source: "{#AppDir}\*"; DestDir: "{app}"; Excludes: "Seijaku.bat,profile"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Clear out everything an older Seijaku left in its folder, so only this
; version's files remain. Only done when the folder holds a Seijaku
; install. The profile in %APPDATA%\Seijaku isn't touched.
Type: filesandordirs; Name: "{app}\*"; Check: IsSeijakuFolder

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Registry]
; Seijaku as an app Windows knows: listed under "Open with" and in
; Settings > Apps > Default apps for web pages and http(s) links.
; Everything is under the user's own Software key, and goes when
; Seijaku is uninstalled. Kept small on purpose: html and http(s)
; only, no PDF or file-type sprawl.
Root: HKCU; Subkey: "Software\Classes\SeijakuHTML"; ValueType: string; ValueName: ""; ValueData: "Seijaku HTML Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SeijakuHTML\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Classes\SeijakuHTML\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -app ""{app}\seijaku\application.ini"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\SeijakuURL"; ValueType: string; ValueName: ""; ValueData: "Seijaku URL"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SeijakuURL"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\SeijakuURL\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Classes\SeijakuURL\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -app ""{app}\seijaku\application.ini"" ""%1"""
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku"; ValueType: string; ValueName: ""; ValueData: "Seijaku"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -app ""{app}\seijaku\application.ini"""
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Seijaku"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "A lightweight, quiet web browser"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities\StartMenu"; ValueType: string; ValueName: "StartMenuInternet"; ValueData: "Seijaku"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities\URLAssociations"; ValueType: string; ValueName: "http"; ValueData: "SeijakuURL"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities\URLAssociations"; ValueType: string; ValueName: "https"; ValueData: "SeijakuURL"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities\FileAssociations"; ValueType: string; ValueName: ".htm"; ValueData: "SeijakuHTML"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities\FileAssociations"; ValueType: string; ValueName: ".html"; ValueData: "SeijakuHTML"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Seijaku"; ValueData: "Software\Clients\StartMenuInternet\Seijaku\Capabilities"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: string; ValueName: "SeijakuHTML"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: string; ValueName: "SeijakuHTML"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\Applications\seijaku.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "Seijaku"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\seijaku.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -app ""{app}\seijaku\application.ini"" ""%1"""

[Icons]
; IconFilename matters now: seijaku.exe is the renamed Firefox binary,
; so its embedded icon is still Firefox's. Point the shortcuts at the
; seal icon instead. Parameters matters just as much: without -app the
; shortcut starts the bare engine, which has no front end left to show
; — that is why 0.1.2 could not be reopened after closing it (the
; post-install [Run] entry had -app, so the first launch worked).
Name: "{autoprograms}\Seijaku"; Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; IconFilename: "{app}\seijaku.ico"
Name: "{autodesktop}\Seijaku"; Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; IconFilename: "{app}\seijaku.ico"; Tasks: desktopicon

[Run]
; The engine binary itself is seijaku.exe, so it needs -app to find the
; shell; without it there is no Firefox front end left to fall back to.
Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; Description: "Start Seijaku"; Flags: nowait postinstall skipifsilent

[Code]
function IsSeijakuFolder: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\seijaku\application.ini'));
end;
