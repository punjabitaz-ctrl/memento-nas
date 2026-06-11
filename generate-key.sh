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

echo "Add these to your .env file:"
echo ""
echo "MEMENTO_KEY=${MEMENTO_KEY}"
echo "SESSION_SECRET=${SESSION_SECRET}"
echo ""
echo "⚠️  SAVE MEMENTO_KEY in a safe place (password manager, printed paper)."
echo "    If you lose it, your vault is permanently unreadable."
echo ""

# Optionally write to .env if it doesn't exist yet
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  # Replace placeholders (use perl for portability across Linux/macOS)
  if command -v perl >/dev/null 2>&1; then
    perl -i -pe "s|REPLACE_WITH_YOUR_64_CHAR_HEX_KEY|${MEMENTO_KEY}|g" .env
    perl -i -pe "s|REPLACE_WITH_ANOTHER_RANDOM_STRING|${SESSION_SECRET}|g" .env
    echo "✅  .env file created and keys filled in automatically."
    echo "    Review and edit HOST_PORT or ANTHROPIC_API_KEY as needed."
  fi
fi
