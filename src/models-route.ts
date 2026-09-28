/**
 * `GET /plugins/clawbot/models` — the catalogue the settings card's dropdowns
 * are built from.
 *
 * The card needs three lists: providers, each provider's models, and each
 * model's reasoning efforts. All three are server facts (they come from
 * registered adapters and provider config), and the browser has no way to ask
 * for them: the client-side `modelDirectories` service reports the *current*
 * selection for a session, not the catalogue. So the plugin publishes what it
 * knows, the same way `dsh-balance-sidebar` publishes `/api/model-balance`.
 *
 * Everything here is name/metadata only — no keys, no endpoints, no counts.
 */
import type { Context } from "@deepseek-ai/cordis";

import { logger } from "./ilink/util/logger.js";

/** One selectable effort, as the card renders it. */
type EffortEntry = { id: string; name: string };

/** One selectable model plus the efforts its adapter accepts. */
type ModelEntry = {
  id: string;
  name: string;
  efforts: readonly EffortEntry[];
  defaultEffort?: string;
  takesImages: boolean;
};

type ProviderEntry = { id: string; name: string; models: readonly ModelEntry[] };

type LlmLike = {
  listProviders?: () => readonly { id: string; name?: string }[];
  listModels?: (provider: string) => Promise<readonly { id: string; name?: string; inputModalities?: readonly string[] }[]>;
  // NOT `resolveModel` — that one lives on LlmAdapter. The service exposes
  // `resolveModelInfo`, and calling the wrong name through `?.()` fails
  // silently: every model came back with an empty effort list.
  resolveModelInfo?: (provider: string, model: string) => Promise<{
    inputModalities?: readonly string[];
    reasoning?: { efforts?: readonly { id: string; name?: string }[]; defaultEffort?: string };
  }>;
};

type WebServerLike = {
  register: (route: { kind: "exact"; path: string; handler: (req: unknown, res: ServerResponseLike) => void | Promise<void> }) => () => void;
};

type ServerResponseLike = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
};

/**
 * Build the catalogue.
 *
 * `resolveModelInfo` is what carries the effort list, and it is called per model —
 * that is one adapter round trip each, so failures are absorbed per model
 * rather than failing the whole response: a provider with one unreachable
 * model should still populate the dropdown with the rest.
 */
async function catalogue(llm: LlmLike): Promise<readonly ProviderEntry[]> {
  const providers = llm.listProviders?.() ?? [];
  const out: ProviderEntry[] = [];
  for (const provider of providers) {
    let models: readonly { id: string; name?: string; inputModalities?: readonly string[] }[] = [];
    try {
      models = (await llm.listModels?.(provider.id)) ?? [];
    } catch (err) {
      logger.warn(`models route: 列 ${provider.id} 的模型失败: ${String(err).slice(0, 100)}`);
    }
    const entries: ModelEntry[] = [];
    for (const model of models) {
      let efforts: readonly EffortEntry[] = [];
      let defaultEffort: string | undefined;
      let takesImages = model.inputModalities?.includes("image") === true;
      try {
        const resolved = await llm.resolveModelInfo?.(provider.id, model.id);
        efforts = (resolved?.reasoning?.efforts ?? []).map((e) => ({ id: e.id, name: e.name ?? e.id }));
        defaultEffort = resolved?.reasoning?.defaultEffort;
        if (resolved?.inputModalities !== undefined) {
          takesImages = resolved.inputModalities.includes("image");
        }
      } catch {
        // A model that will not resolve still belongs in the list — the user may
        // be configuring it before its key exists. It just has no effort list.
      }
      entries.push({
        id: model.id,
        name: model.name ?? model.id,
        efforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        takesImages,
      });
    }
    out.push({ id: provider.id, name: provider.name ?? provider.id, models: entries });
  }
  return out;
}

/**
 * Register the route, but only where both services exist.
 *
 * Both are read through `ctx.inject`: naming them in the plugin's own `inject`
 * list would make them hard requirements and take the whole loader tree down in
 * a headless composition that has neither. A bare property read is not an
 * option either — cordis THROWS for an un-injected service.
 */
export function registerModelsRoute(ctx: Context): void {
  ctx.inject(["webServer", "llm"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;
    const llm = (scoped as unknown as { llm: LlmLike }).llm;
    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: "/plugins/clawbot/models",
          async handler(_req, res) {
            try {
              const providers = await catalogue(llm);
              const body = JSON.stringify({ ok: true, providers });
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(body);
            } catch (err) {
              logger.warn(`models route 失败: ${String(err).slice(0, 160)}`);
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, message: String(err).slice(0, 200) }));
            }
          },
        }),
      "clawbot: models route",
    );
  });
}
