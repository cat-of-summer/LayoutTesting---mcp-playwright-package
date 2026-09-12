#!/bin/sh
set -e

WORKDIR="/var/www/html/${PLAYWRIGHT_WORKDIR:-.}"
TIMEOUT="${PLAYWRIGHT_WAIT_TIMEOUT:-300}"
MODE="${PLAYWRIGHT_MODE:-mcp}"

mkdir -p "$WORKDIR"
cd "$WORKDIR"

# Lighthouse и pa11y поднимают браузер сами и без CHROME_PATH полезут скачивать свой.
if [ -z "${CHROME_PATH}" ]; then
  CHROME_PATH="$(find /ms-playwright -type f \( -name 'chrome' -o -name 'headless_shell' \) 2>/dev/null | head -1)"
  export CHROME_PATH
fi
export PUPPETEER_SKIP_DOWNLOAD=1
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
export PUPPETEER_EXECUTABLE_PATH="${CHROME_PATH}"
echo "[playwright] CHROME_PATH=${CHROME_PATH:-не найден}"

waited=0
while [ ! -f "package.json" ] && [ "$waited" -lt "$TIMEOUT" ]; do
  [ "$waited" = 0 ] && echo "[playwright] Жду $WORKDIR/package.json (до ${TIMEOUT}с)..."
  sleep 2
  waited=$((waited + 2))
done

if [ ! -f "package.json" ]; then
  echo "[playwright] Нет package.json в $WORKDIR спустя ${TIMEOUT}с. Простаиваю."
  exec sleep infinity
fi

if [ -f "yarn.lock" ]; then
  command -v yarn >/dev/null 2>&1 || npm install -g yarn || echo "[playwright] yarn bootstrap failed (continuing)"
  yarn install || echo "[playwright] yarn install failed (continuing)"
else
  npm install || echo "[playwright] npm install failed (continuing)"
fi

# Свои bin-скрипты проекта — в PATH, чтобы `docker compose exec` вызывал их по имени.
# Кладём обёртку в файловую систему контейнера, а не симлинк на смонтированный файл:
# правка исходника из Windows или IDE сбрасывает бит исполнения, и симлинк умирает.
node -e '
  const fs = require("fs"), path = require("path");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  for (const [name, file] of Object.entries(bin)) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) continue;
    const wrapper = "/usr/local/bin/" + name;
    try {
      fs.rmSync(wrapper, { force: true });
      fs.writeFileSync(wrapper, "#!/bin/sh\nexec node " + JSON.stringify(abs) + " \"$@\"\n");
      fs.chmodSync(wrapper, 0o755);
      console.log("[playwright] команда " + name + " готова");
    } catch (e) {
      console.log("[playwright] не удалось создать команду " + name + ": " + e.message);
    }
  }
' 2>/dev/null || true

case "$MODE" in
  test)
    exec npm test
    ;;
  idle)
    echo "[playwright] Режим idle. Простаиваю."
    exec sleep infinity
    ;;
  *)
    # Не ушёл ли Figma API вперёд закреплённой версии. Только предупреждает: старт не задерживает
    # дольше таймаута запроса и не прерывает.
    if [ -f bin/figma-api-check.mjs ]; then
      node bin/figma-api-check.mjs || true
    fi
    echo "[playwright] MCP-сервер на 0.0.0.0:${MCP_PORT:-8931}"
    exec npm run mcp:http
    ;;
esac
