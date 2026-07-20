#!/bin/bash
# Atualiza data.json do Painel Leads FG e publica (roda via launchd a cada 15 min).
H=$(TZ=America/Sao_Paulo date +%H)
[ "$H" -lt 7 ] && exit 0
[ "$H" -gt 21 ] && exit 0
cd "$HOME/painel-leads-fg" || exit 1
TOK=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/Claude/claude_desktop_config.json')))['mcpServers']['digisac']['env']['DIGISAC_TOKEN'])") || exit 1
git pull --rebase --quiet 2>/dev/null
DIGISAC_TOKEN="$TOK" SLA_MIN=15 /usr/local/bin/node generate.mjs 2>/dev/null || DIGISAC_TOKEN="$TOK" SLA_MIN=15 node generate.mjs || exit 1
if ! git diff --quiet -- data.json; then
  git add data.json && git commit -qm "auto: data.json (Mac $(TZ=America/Sao_Paulo date +%H:%M))" && git push --quiet
fi
