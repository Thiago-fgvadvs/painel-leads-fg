# Painel de Leads FG — versão web (GitHub Pages)

Painel **somente visualização** de leads do WhatsApp (DigiSac), acessível de qualquer lugar.
Mostra os leads recebidos no dia, quem atendeu cada um, o tempo de 1ª resposta, quem está
fora do SLA de 15 min e quem ainda está sem resposta. Telefones mascarados (LGPD).

## Como funciona (arquitetura segura)

O navegador **não** fala com a API DigiSac (isso exporia o token e esbarraria em CORS).
Em vez disso:

1. `generate.mjs` roda no **GitHub Actions** (servidor), lê a API DigiSac usando o token
   guardado como **Secret**, calcula tudo e grava `data.json`.
2. `index.html` (estático) apenas lê `data.json` e desenha os gráficos/tabelas.
3. O GitHub Pages publica a pasta. Quem abre a página vê o último `data.json` gerado.

Ou seja: o token nunca sai do servidor; a página é 100% pública e inofensiva.

## Publicar (uma vez)

1. Crie um repositório **privado ou público** no GitHub e suba esta pasta
   (`index.html`, `data.json`, `generate.mjs`, `.github/`).
2. Em **Settings → Secrets and variables → Actions**:
   - Secret `DIGISAC_TOKEN` = o token da API DigiSac.
   - (opcional) Variable `DIGISAC_BASE_URL` = `https://fernandagehmadvogados.digisac.co/api/v1`.
3. Em **Settings → Pages**: Source = **GitHub Actions**.
4. Aba **Actions** → rode "Atualizar painel de leads" (workflow_dispatch) uma vez.
   A URL pública aparece ao fim do job (algo como `https://SEU-USUARIO.github.io/REPO/`).

Depois disso atualiza sozinho a cada ~15 min (cron do workflow), das 08h às 20h de SP.

## Rodar localmente (teste)

```bash
DIGISAC_TOKEN=xxxx node generate.mjs   # regrava data.json
# abra index.html num servidor local, ex.:
python3 -m http.server 8080            # depois acesse http://localhost:8080
```

## Limitações honestas

- **Não é streaming**: atualiza a cada disparo do Actions (~15 min), não em tempo real contínuo.
- **Sem conversão**: lead→cliente exige cruzamento Projuris/Notion e permanece no relatório
  periódico, não neste painel.
- **Privacidade**: se o repositório for público, qualquer um com a URL vê o painel. Como não há
  telefones completos nem dados sensíveis, o risco é baixo — mas para uso interno prefira
  repositório privado + Pages restrito, ou proteção por senha via Cloudflare Access.
- **Cron do GitHub é "melhor esforço"**: pode atrasar alguns minutos em horários de pico.

## Arquivos

```
index.html   painel estático (lê data.json)
data.json    snapshot atual (gerado pelo generate.mjs)
generate.mjs gerador Node (API DigiSac → data.json), token via env
.github/workflows/atualizar.yml  automação GitHub Actions + Pages
```
