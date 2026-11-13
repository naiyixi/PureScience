#!/usr/bin/env bash
# One-shot local setup for macOS release signing: reads the two files you downloaded, sets the five
# repository secrets and the one Team ID variable with the gh CLI, then optionally runs the preflight lane.
#
# Nothing here is ever printed in a form that can be copied into a chat: the base64 payloads go straight
# from disk into `gh secret set` on stdin, and the .p12 password is read with `read -s`.
#
# Usage:
#   ./scripts/sign-mac-setup.sh                # interactive, the normal path
#   ./scripts/sign-mac-setup.sh --dry-run      # validate files and report, touch nothing on GitHub
set -euo pipefail

REPO="${REPO:-naiyixi/PureScience}"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- prerequisites
need() { command -v "$1" >/dev/null 2>&1 || die "missing $1"; }
need gh
need base64
need openssl

gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"

step "1/4  The .p12 certificate"
say "  Keychain Access → My Certificates → right-click 'Developer ID Application: … (TEAMID)' → Export…"
say "  Save as a .p12 and set a password (you will type that password once, below)."
candidates=()
while IFS= read -r line; do candidates+=("$line"); done < <(ls -1 "$HOME"/Desktop/*.p12 "$HOME"/Downloads/*.p12 2>/dev/null || true)
if [ "${#candidates[@]}" -gt 0 ]; then
  say "  Found:"
  for i in "${!candidates[@]}"; do say "    [$((i + 1))] ${candidates[$i]}"; done
  say "    [0] type a path myself"
  read -r -p "  Choose: " pick
  if [ "${pick:-0}" != "0" ] && [ -n "${candidates[$((pick - 1))]:-}" ]; then
    P12="${candidates[$((pick - 1))]}"
  else
    read -r -p "  Path to .p12: " P12
  fi
else
  read -r -p "  Path to .p12: " P12
fi
P12="${P12/#\~/$HOME}"
[ -f "$P12" ] || die "no such file: $P12"

read -r -s -p "  Password of that .p12: " P12_PASSWORD
printf '\n'
[ -n "$P12_PASSWORD" ] || die "empty password — the import in CI needs it"

# Prove the pair really opens before anything is stored: a wrong password here is the single most common
# reason a credentialed release build fails minutes later.
if ! openssl pkcs12 -in "$P12" -passin "pass:$P12_PASSWORD" -noout -legacy 2>/dev/null &&
  ! openssl pkcs12 -in "$P12" -passin "pass:$P12_PASSWORD" -noout 2>/dev/null; then
  die "openssl cannot open $P12 with that password — re-export the certificate"
fi
say "  ✓ certificate opens with that password"

# ---------------------------------------------------------------- team id
step "2/4  Team ID"
cert_subject="$(openssl pkcs12 -in "$P12" -passin "pass:$P12_PASSWORD" -nokeys -clcerts 2>/dev/null |
  openssl x509 -noout -subject 2>/dev/null | head -1 || true)"
detected="$(printf '%s' "$cert_subject" | grep -Eo '\([A-Z0-9]{10}\)' | tr -d '()' | head -1 || true)"
if [ -n "$detected" ]; then
  say "  Read from the certificate: $detected"
  read -r -p "  Team ID [$detected]: " TEAM_ID
  TEAM_ID="${TEAM_ID:-$detected}"
else
  read -r -p "  Team ID (10 characters, in the certificate name): " TEAM_ID
fi
printf '%s' "$TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$' || die "Team ID must be 10 uppercase letters/digits"

# ---------------------------------------------------------------- api key
step "3/4  App Store Connect API key (.p8)"
say "  App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → +"
say "  Role: Developer. Download the .p8 (only offered once)."
read -r -p "  Path to AuthKey_XXXXXXXXXX.p8: " P8
P8="${P8/#\~/$HOME}"
[ -f "$P8" ] || die "no such file: $P8"
grep -q "PRIVATE KEY" "$P8" || die "$P8 is not a PEM private key — that is not the .p8 file"

default_key_id="$(basename "$P8" | sed -n 's/^AuthKey_\([A-Z0-9]\{10\}\)\.p8$/\1/p')"
read -r -p "  Key ID${default_key_id:+ [$default_key_id]}: " KEY_ID
KEY_ID="${KEY_ID:-$default_key_id}"
printf '%s' "$KEY_ID" | grep -Eq '^[A-Z0-9]{10}$' || die "Key ID must be 10 uppercase letters/digits"

say "  Issuer ID is the UUID shown above the key list (not the Key ID)."
read -r -p "  Issuer ID: " ISSUER
printf '%s' "$ISSUER" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
  die "Issuer ID must be a UUID"

# ---------------------------------------------------------------- upload
step "4/4  Set secrets on $REPO"
if [ "$DRY_RUN" = "1" ]; then
  say "  --dry-run: skipping. Would set:"
  say "    secret   MAC_CSC_LINK              ($(wc -c <"$P12" | tr -d ' ') bytes → base64)"
  say "    secret   MAC_CSC_KEY_PASSWORD      (from the prompt above)"
  say "    secret   APPLE_API_KEY_P8_BASE64   ($(wc -c <"$P8" | tr -d ' ') bytes → base64)"
  say "    secret   APPLE_API_KEY_ID          $KEY_ID"
  say "    secret   APPLE_API_ISSUER          $ISSUER"
  say "    variable PURESCIENCE_MAC_TEAM_ID   $TEAM_ID"
  exit 0
fi

base64 -i "$P12" | gh secret set MAC_CSC_LINK --repo "$REPO"
printf '%s' "$P12_PASSWORD" | gh secret set MAC_CSC_KEY_PASSWORD --repo "$REPO"
base64 -i "$P8" | gh secret set APPLE_API_KEY_P8_BASE64 --repo "$REPO"
printf '%s' "$KEY_ID" | gh secret set APPLE_API_KEY_ID --repo "$REPO"
printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER --repo "$REPO"
gh variable set PURESCIENCE_MAC_TEAM_ID --repo "$REPO" --body "$TEAM_ID"

say "  ✓ five secrets and one variable are set on $REPO"

read -r -p "Run the Signing preflight lane now? [Y/n] " go
case "${go:-Y}" in
  [Yy]*) gh workflow run signing-preflight.yml --repo "$REPO" && say "  queued — watch it with: gh run watch" ;;
  *) say "  skipped — run it later with: gh workflow run signing-preflight.yml" ;;
esac
