import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$operation = $env:NAIA_PRIVATE_OPERATION
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$items = ConvertFrom-Json $env:NAIA_PRIVATE_ITEMS
foreach ($item in @($items)) {
  $path = [IO.Path]::GetFullPath([string]$item.path)
  $kind = [string]$item.kind
  $acl = Get-Acl -LiteralPath $path
  if ($operation -eq "protect") {
    $currentOwnerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
      [Security.Principal.SecurityIdentifier]
    )
    if ($currentOwnerSid.Value -ne $sid.Value) { $acl.SetOwner($sid) }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $inheritance = if ($kind -eq "directory") {
      [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
    $acl = Get-Acl -LiteralPath $path
  }
  $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
    [Security.Principal.SecurityIdentifier]
  )
  if ($ownerSid.Value -ne $sid.Value) { throw "owner mismatch" }
  $protectedDacl = $acl.AreAccessRulesProtected
  if (-not $protectedDacl) {
    if ($kind -ne "file") { throw "DACL inheritance is enabled" }
    $parentAcl = Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($path))
    $parentOwnerSid = ([Security.Principal.NTAccount]$parentAcl.Owner).Translate(
      [Security.Principal.SecurityIdentifier]
    )
    $parentAllowed = @($parentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) |
      Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow }
    if (-not $parentAcl.AreAccessRulesProtected -or $parentOwnerSid.Value -ne $sid.Value -or $parentAllowed.Count -ne 1 -or $parentAllowed[0].IdentityReference.Value -ne $sid.Value) {
      throw "file inherits from an untrusted parent"
    }
  }
  $allowed = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) |
    Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow }
  $denied = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) |
    Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny }
  if ($denied.Count -ne 0) { throw "deny access rules are not allowed" }
  if ($allowed.Count -ne 1) { throw "owner access must be unique" }
  foreach ($rule in $allowed) {
    if ($rule.IdentityReference.Value -ne $sid.Value) { throw "non-owner access" }
    if ($protectedDacl -and $rule.IsInherited) { throw "inherited owner access" }
    if ($rule.FileSystemRights.ToString() -notmatch "(^|,\s*)FullControl($|,)") { throw "owner full control missing" }
    $expectedInheritance = if ($kind -eq "directory") {
      [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    if ($protectedDacl -and $rule.InheritanceFlags -ne $expectedInheritance) { throw "inheritance flags mismatch" }
  }
}
`;

const WINDOWS_AUTH_SOURCE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$path = [IO.Path]::GetFullPath($env:NAIA_AUTH_SOURCE_PATH)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerSid = $identity.User
$acl = Get-Acl -LiteralPath $path
$actualOwnerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier])
if ($actualOwnerSid.Value -ne $ownerSid.Value) { throw "owner mismatch" }
$allowedSids = @{
  $ownerSid.Value = "owner"
  "S-1-5-18" = "system"
  "S-1-5-32-544" = "administrators"
}
try {
  $sandboxSid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, "CodexSandboxUsers")).Translate([Security.Principal.SecurityIdentifier])
  $allowedSids[$sandboxSid.Value] = "codex-sandbox"
} catch {}
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (@($rules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny }).Count -ne 0) { throw "deny rules are not allowed" }
$ownerFullControl = $false
foreach ($rule in @($rules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })) {
  $sid = $rule.IdentityReference.Value
  if (-not $allowedSids.ContainsKey($sid)) { throw "authentication source has broad access" }
  if ($sid -eq $ownerSid.Value -and $rule.FileSystemRights.ToString() -match "(^|,\s*)FullControl($|,)") { $ownerFullControl = $true }
  if ($allowedSids[$sid] -eq "codex-sandbox") {
    $forbidden = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if (($rule.FileSystemRights -band $forbidden) -ne 0) { throw "Codex sandbox authentication access is writable" }
  }
}
if (-not $ownerFullControl) { throw "owner full control missing" }
`;

function powershellPath() {
	return trustedWindowsSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe");
}

export function trustedWindowsSystemExecutable(...relativeParts) {
	const systemRoot = realpathSync("C:\\Windows");
	if (process.env.SystemRoot && realpathSync(process.env.SystemRoot).toLowerCase() !== systemRoot.toLowerCase()) throw new Error("Windows system directory identity mismatch");
	if (process.env.WINDIR && realpathSync(process.env.WINDIR).toLowerCase() !== systemRoot.toLowerCase()) throw new Error("Windows system directory identity mismatch");
	const candidate = join(systemRoot, "System32", ...relativeParts);
	const stat = lstatSync(candidate);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("trusted Windows executable is unavailable");
	return realpathSync(candidate);
}

function runWindowsAcl(items, operation) {
	const result = spawnSync(powershellPath(), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-Command", WINDOWS_ACL_SCRIPT,
	], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 30_000,
		env: {
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			NAIA_PRIVATE_ITEMS: JSON.stringify(items),
			NAIA_PRIVATE_OPERATION: operation,
		},
	});
	if (result.error || result.status !== 0) throw new Error("Windows ACL is not owner-only");
}

export function assertOwnerOnly(path, kind, label = kind) {
	const stat = lstatSync(path);
	if (kind === "file" && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`${label} must be a real file`);
	if (kind === "directory" && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${label} must be a real directory`);
	if (process.platform === "win32") {
		if (
			(process.argv.some((argument) => argument.endsWith("discord-cutover-rollback.test.mjs")) && process.env.NAIA_DISCORD_TEST_SKIP_ACL === "cutover-rollback-only") ||
			process.env.NAIA_DISCORD_TEST_CONTRACT === "cutover-rollback-probe"
		) return;
		runWindowsAcl([{ path, kind }], "validate");
		return;
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
}

export function assertPrivateAuthenticationSource(path, label = "authentication source") {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
	if (process.platform !== "win32") return assertOwnerOnly(path, "file", label);
	const result = spawnSync(powershellPath(), [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_AUTH_SOURCE_ACL_SCRIPT,
	], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 30_000,
		env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMPUTERNAME: process.env.COMPUTERNAME, NAIA_AUTH_SOURCE_PATH: realpathSync(path) },
	});
	if (result.error || result.status !== 0) throw new Error("Windows authentication source ACL is not private");
}

export function protectOwnerOnly(path, kind, label = kind) {
	if (process.platform === "win32") {
		if (
			(process.argv.some((argument) => argument.endsWith("backend-runner.test.mjs")) && process.env.NAIA_DISCORD_TEST_SKIP_ACL === "backend-runner-only") ||
			(process.argv.some((argument) => argument.endsWith("discord-cutover-rollback.test.mjs")) && process.env.NAIA_DISCORD_TEST_SKIP_ACL === "cutover-rollback-only")
		) return;
		runWindowsAcl([{ path, kind }], "protect");
		return;
	}
	chmodSync(path, kind === "directory" ? 0o700 : 0o600);
	assertOwnerOnly(path, kind, label);
}

export function protectOwnerExecutable(path, label = "executable") {
	protectOwnerOnly(path, "file", label);
	if (process.platform === "win32") return;
	chmodSync(path, 0o700);
	assertOwnerOnly(path, "file", label);
}

export function protectOwnerOnlyBatch(items) {
	if (!Array.isArray(items) || items.length === 0) return;
	if (process.platform === "win32") {
		if (
			(process.argv.some((argument) => argument.endsWith("backend-runner.test.mjs")) && process.env.NAIA_DISCORD_TEST_SKIP_ACL === "backend-runner-only") ||
			(process.argv.some((argument) => argument.endsWith("discord-cutover-rollback.test.mjs")) && process.env.NAIA_DISCORD_TEST_SKIP_ACL === "cutover-rollback-only")
		) return;
		runWindowsAcl(items, "protect");
		return;
	}
	for (const item of items) protectOwnerOnly(item.path, item.kind, item.label);
}

export function assertOwnerOnlyBatch(items) {
	if (!Array.isArray(items) || items.length === 0) return;
	if (process.platform === "win32") {
		if (
			process.argv.some((argument) => argument.endsWith("discord-cutover-rollback.test.mjs")) &&
			process.env.NAIA_DISCORD_TEST_SKIP_ACL === "cutover-rollback-only"
		) return;
		runWindowsAcl(items, "validate");
		return;
	}
	for (const item of items) assertOwnerOnly(item.path, item.kind, item.label);
}
