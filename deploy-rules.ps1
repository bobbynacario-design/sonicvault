# Blessed deploy for the shared Firestore ruleset.
#
# This repo (sonicvault) is the SINGLE SOURCE OF TRUTH for the rules of all
# three apps on Firebase project pokerhq-a67e4 (PokerHQ, Daily Briefing,
# SonicVault). The pokerhq and bobdailybriefing repos must NOT deploy rules.
# See the header of firestore.rules for the full policy.
#
# Usage:  ./deploy-rules.ps1

$ErrorActionPreference = "Stop"

Write-Host "Deploying canonical Firestore rules -> project pokerhq-a67e4" -ForegroundColor Cyan
Write-Host "(covers PokerHQ + Daily Briefing + SonicVault in one ruleset)" -ForegroundColor DarkGray

firebase deploy --only firestore:rules

if ($LASTEXITCODE -eq 0) {
  Write-Host "Done. The full merged ruleset is live for all three apps." -ForegroundColor Green
} else {
  Write-Host "Deploy failed (exit $LASTEXITCODE). Rules were NOT changed." -ForegroundColor Red
  exit $LASTEXITCODE
}
