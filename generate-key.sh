#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# Memento — Key Generator
# Generates two secure random hex strings for MEMENTO_KEY and SESSION_SECRET.
# Run this ONCE, then paste both values into your .env file.
# ─────────────────────────────────────────────────────────────────────────────

set -e

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║        Memento Key Generator                              ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Try node first (most common)
if command -v node >/dev/null 2>&1; then
  MEMENTO_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  SESSION_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
# Fall back to openssl (available on most Unix systems including NAS)
elif command -v openssl >/dev/null 2>&1; then
  MEMENTO_KEY=$(openssl rand -hex 32)
  SESSION_SECRET=$(openssl rand -hex 32)
# Python 3 fallback
elif command -v python3 >/dev/null 2>&1; then
  MEMENTO_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  SESSION_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
else
  echo "ERROR: Could not find node, openssl, or python3."
  echo "Please generate two 64-character hex strings manually and paste them into .env."
  exit 1
fi

if [ -f ".env" ] && ! grep -q "REPLACE_WITH" .env 2>/dev/null; then
  echo "A .env with real keys already exists. Not touching it."
  echo "(Replacing MEMENTO_KEY on a vault that has data would make that data unreadable.)"
  exit 0
fi

# Optionally write to .env if it doesn't exist yet
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  # Replace placeholders (use perl for portability across Linux/macOS)
  if command -v perl >/dev/null 2>&1; then
    perl -i -pe "s|REPLACE_WITH_YOUR_64_CHAR_HEX_KEY|${MEMENTO_KEY}|g" .env
    perl -i -pe "s|REPLACE_WITH_ANOTHER_RANDOM_STRING|${SESSION_SECRET}|g" .env
    chmod 600 .env 2>/dev/null || true
    echo "✅  .env created with fresh keys."
    echo ""
    echo "Your encryption key (MEMENTO_KEY):"
    echo "    ${MEMENTO_KEY}"
    echo ""
    echo "⚠️  SAVE IT NOW in a password manager AND print a copy."
    echo "    Lose it and the vault can never be opened again, by anyone."
    echo "    Next: set MEMENTO_DATA (and PUID/PGID on a NAS) in .env, then: docker compose up -d --build"
  else
    echo "perl not found: edit .env by hand with:"
    echo "MEMENTO_KEY=${MEMENTO_KEY}"
    echo "SESSION_SECRET=${SESSION_SECRET}"
  fi
else
  echo "No .env.example found: run this from the memento-nas folder."
  exit 1
fi
