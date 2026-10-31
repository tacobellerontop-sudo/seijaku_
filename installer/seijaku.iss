; Seijaku's Windows installer (Inno Setup 6).
;
;   iscc /DAppVersion=<version> /DAppDir=..\out\seijaku /DOutDir=..\release installer\seijaku.iss
;
; Installs the packaged app (scripts/build/package.ps1) for the current
; user only, into %LOCALAPPDATA%\Programs\Seijaku. No admin rights, no
; Firefox, and nothing else to install first: the engine is inside the
; package, with seijaku.exe as a small launcher that starts it, so it
; needs nothing else at all.
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
; Seijaku is uninstalled. Kept small on purpose: html, PDF and
; http(s) only. The open commands start with -osint (the engine's
; marker for an address from the OS): seijaku.exe checks it and adds
; -app itself, because the engine refuses -osint after any other flag.
Root: HKCU; Subkey: "Software\Classes\SeijakuHTML"; ValueType: string; ValueName: ""; ValueData: "Seijaku HTML Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SeijakuHTML\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Classes\SeijakuHTML\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -osint -url ""%1"""
Root: HKCU; Subkey: "Software\Classes\SeijakuPDF"; ValueType: string; ValueName: ""; ValueData: "Seijaku PDF Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SeijakuPDF\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Classes\SeijakuPDF\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -osint -url ""%1"""
Root: HKCU; Subkey: "Software\Classes\SeijakuURL"; ValueType: string; ValueName: ""; ValueData: "Seijaku URL"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SeijakuURL"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\SeijakuURL\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\seijaku.ico"
Root: HKCU; Subkey: "Software\Classes\SeijakuURL\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -osint -url ""%1"""
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
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Seijaku\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pdf"; ValueData: "SeijakuPDF"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Seijaku"; ValueData: "Software\Clients\StartMenuInternet\Seijaku\Capabilities"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: string; ValueName: "SeijakuHTML"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: string; ValueName: "SeijakuHTML"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "SeijakuPDF"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\Applications\seijaku.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "Seijaku"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\seijaku.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\seijaku.exe"" -osint -url ""%1"""

[Icons]
; IconFilename matters: the running browser is firefox.exe, whose
; embedded icon is Firefox's. Point the shortcuts at the seal icon
; instead. (The launcher seijaku.exe itself carries the seal icon too,
; but the taskbar button comes from the AppUserModelID match, below.)
; Parameters matters just as much: without -app the shortcut starts
; the bare engine, which has no front end left to show — that is why
; 0.1.2 could not be reopened after closing it (the post-install [Run]
; entry had -app, so the first launch worked).
; AppUserModelID matters most of all for the taskbar: Windows groups
; the running window's button by this ID and takes the button's icon
; from the shortcut that matches it. It must be identical to the ID
; the shell sets on its window in seijaku.js (Seijaku.Seijaku), or
; the button falls back to the exe — Firefox's icon again.
Name: "{autoprograms}\Seijaku"; Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; IconFilename: "{app}\seijaku.ico"; AppUserModelID: "Seijaku.Seijaku"
Name: "{autodesktop}\Seijaku"; Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; IconFilename: "{app}\seijaku.ico"; AppUserModelID: "Seijaku.Seijaku"; Tasks: desktopicon

[Run]
; seijaku.exe is the launcher: it forwards -app to firefox.exe, which
; finds the shell; without -app there is no Firefox front end left to
; fall back to.
Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; Description: "Start Seijaku"; Flags: nowait postinstall skipifsilent
; In-app updates run this installer straight from Seijaku with
; /VERYSILENT /update=1, with no script in between (a script made Windows
; ask for permission). Start Seijaku again once the files are in place.
Filename: "{app}\seijaku.exe"; Parameters: "-app ""{app}\seijaku\application.ini"""; Flags: nowait; Check: IsUpdate

[Code]
function IsSeijakuFolder: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\seijaku\application.ini'));
end;

function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:update|0}') = '1';
end;

// How many processes run from the install folder: the engine, its
// content processes, and anything it starts at shutdown. Only this
// folder counts, so a real Firefox left open never holds up an
// update. With Kill, those processes are ended as well.
function SeijakuProcessCount(Kill: Boolean): Integer;
var
  Locator, Service, Procs, Proc: Variant;
  Dir, Path: String;
  I, N: Integer;
begin
  Result := 0;
  Dir := Lowercase(AddBackslash(ExpandConstant('{app}')));
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Procs := Service.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE ExecutablePath IS NOT NULL');
    N := Procs.Count;
    for I := 0 to N - 1 do
    begin
      Proc := Procs.ItemIndex(I);
      Path := Proc.ExecutablePath;
      Path := Lowercase(Path);
      if Copy(Path, 1, Length(Dir)) = Dir then
      begin
        Result := Result + 1;
        if Kill then
          try
            Proc.Terminate();
          except
          end;
      end;
    end;
  except
    Log('Could not list running processes: ' + GetExceptionMessage);
    Result := 0;
  end;
end;

// For an in-app update, Seijaku starts this installer and then quits.
// Wait for it to be gone before replacing its files; anything from the
// install folder still running after a minute is stuck, and is ended.
// A hand-run install keeps Inno's usual "close these apps" handling.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Waited: Integer;
begin
  Result := '';
  if not IsUpdate then
    Exit;
  Waited := 0;
  while SeijakuProcessCount(False) > 0 do
  begin
    if Waited >= 60000 then
    begin
      Log('Seijaku still running after a minute; ending it');
      SeijakuProcessCount(True);
      Sleep(2000);
      Break;
    end;
    Sleep(500);
    Waited := Waited + 500;
  end;
end;
