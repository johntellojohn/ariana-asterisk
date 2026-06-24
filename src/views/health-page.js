function renderHealthPage(options) {
    const status = options.ok ? "Online" : "Attention";
    const checkedAt = options.timestamp || new Date().toISOString();
    const ari = options.ari || {};
    const pbx = options.pbx || {};

    return `<!doctype html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)} - ${status}</title>
    <style>
        :root {
            color-scheme: light dark;
            --ink: #17191f;
            --muted: #626b7a;
            --panel: rgba(255, 255, 255, 0.9);
            --line: rgba(23, 25, 31, 0.12);
            --green: #18a058;
            --red: #c83f49;
            --indigo: #4b5bdc;
            --gold: #d89100;
            --teal: #168f85;
            --shadow: 0 24px 80px rgba(42, 31, 12, 0.18);
        }

        * {
            box-sizing: border-box;
        }

        body {
            min-height: 100vh;
            margin: 0;
            display: grid;
            place-items: center;
            padding: 32px;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: var(--ink);
            background:
                radial-gradient(circle at 14% 22%, rgba(216, 145, 0, 0.23), transparent 28%),
                radial-gradient(circle at 82% 16%, rgba(75, 91, 220, 0.17), transparent 31%),
                linear-gradient(135deg, #f8f2e5 0%, #f8fafc 48%, #eef7f4 100%);
        }

        main {
            width: min(980px, 100%);
            border: 1px solid var(--line);
            border-radius: 18px;
            background: var(--panel);
            box-shadow: var(--shadow);
            overflow: hidden;
            backdrop-filter: blur(14px);
        }

        .top {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 24px;
            padding: 34px;
            border-bottom: 1px solid var(--line);
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .mark {
            width: 56px;
            height: 56px;
            border-radius: 16px;
            display: grid;
            place-items: center;
            color: white;
            font-weight: 800;
            font-size: 22px;
            background: linear-gradient(135deg, var(--gold), var(--indigo));
            box-shadow: 0 16px 32px rgba(216, 145, 0, 0.24);
        }

        h1 {
            margin: 0;
            font-size: clamp(28px, 4vw, 44px);
            line-height: 1.05;
            letter-spacing: 0;
        }

        .subtitle {
            margin: 8px 0 0;
            color: var(--muted);
            font-size: 16px;
        }

        .status {
            align-self: start;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: 999px;
            border: 1px solid ${pbx.connected ? "rgba(24, 160, 88, 0.28)" : "rgba(200, 63, 73, 0.28)"};
            background: ${pbx.connected ? "rgba(24, 160, 88, 0.11)" : "rgba(200, 63, 73, 0.1)"};
            color: ${pbx.connected ? "#11693c" : "#8e2730"};
            font-weight: 750;
            white-space: nowrap;
        }

        .dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: ${pbx.connected ? "var(--green)" : "var(--red)"};
            box-shadow: 0 0 0 7px ${pbx.connected ? "rgba(24, 160, 88, 0.14)" : "rgba(200, 63, 73, 0.13)"};
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 1px;
            background: var(--line);
        }

        .metric {
            min-height: 132px;
            padding: 24px;
            background: rgba(255, 255, 255, 0.68);
        }

        .label {
            margin: 0 0 10px;
            color: var(--muted);
            font-size: 13px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .value {
            margin: 0;
            font-size: 18px;
            font-weight: 760;
            overflow-wrap: anywhere;
        }

        .footer {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 20px 34px;
            color: var(--muted);
            font-size: 14px;
            background: rgba(255, 255, 255, 0.48);
        }

        code {
            color: var(--indigo);
            font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
            font-size: 13px;
        }

        @media (max-width: 820px) {
            body {
                padding: 18px;
            }

            .top {
                grid-template-columns: 1fr;
                padding: 24px;
            }

            .grid {
                grid-template-columns: 1fr;
            }

            .footer {
                flex-direction: column;
                padding: 18px 24px;
            }
        }
    </style>
</head>
<body>
    <main>
        <section class="top">
            <div class="brand">
                <div class="mark">AA</div>
                <div>
                    <h1>${escapeHtml(options.title)}</h1>
                    <p class="subtitle">${escapeHtml(options.subtitle)}</p>
                </div>
            </div>
            <div class="status"><span class="dot"></span>${pbx.connected ? "PBX conectado" : "Servicio online"}</div>
        </section>

        <section class="grid">
            ${metric("Servicio", options.service)}
            ${metric("AMI", pbx.connected ? "Conectado" : pbx.enabled ? "Esperando conexion" : "Desactivado")}
            ${metric("ARI", ari.connected ? "Conectado" : ari.enabled ? "Esperando conexion" : "Desactivado")}
            ${metric("Host PBX", pbx.host ? `${pbx.host}:${pbx.port}` : "-")}
            ${metric("App ARI", ari.appName || "-")}
            ${metric("Ultimo evento", ari.lastEventTime || pbx.lastAmiEventTime || "-")}
        </section>

        <div class="footer">
            <span>Ultima verificacion: ${escapeHtml(checkedAt)}</span>
            <code>${escapeHtml(options.endpoint)}</code>
        </div>
    </main>
</body>
</html>`;
}

function metric(label, value) {
    return `<article class="metric">
        <p class="label">${escapeHtml(label)}</p>
        <p class="value">${escapeHtml(value || "-")}</p>
    </article>`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

module.exports = renderHealthPage;
