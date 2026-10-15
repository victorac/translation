import type {
  ConnectionTestResult,
  ProviderView,
  SaveProviderInput,
} from "@ltw/domain";
import {
  checkEndpointAllowed,
  OPENAI_COMPATIBLE_KIND,
  OpenAICompatibleProvider,
  parseEndpoint,
  toProviderError,
  type OpenAICompatibleOptions,
  type ProviderConfig,
  type ProviderError,
} from "@ltw/providers";
import {
  UserError,
} from "./errors.js";
import type {
  CredentialStore,
  SettingsStore,
} from "./storage.js";

const CREDENTIAL_REF = "local-provider";

/** The saved connection to a local model server: address, approval for non-local hosts, and the optional API key. */
export class ProviderService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly adapterOptions: Pick<OpenAICompatibleOptions, "fetch" | "timeouts"> = {},
  ) {}

  view(): ProviderView {
    const { baseUrl, allowedRemoteHost } = this.settings.load().provider;
    const parsed = parseEndpoint(baseUrl);
    const check = checkEndpointAllowed(baseUrl, new Set(allowedRemoteHost ? [allowedRemoteHost] : []));
    return {
      baseUrl: parsed.ok ? parsed.baseUrl : baseUrl,
      host: parsed.ok ? parsed.host : "",
      loopback: parsed.ok ? parsed.loopback : true,
      remoteAllowed: parsed.ok && !parsed.loopback && allowedRemoteHost === parsed.host,
      hasApiKey: this.credentials.has(CREDENTIAL_REF),
      problem: check.ok ? null : check.message,
    };
  }

  save(input: SaveProviderInput): ProviderView {
    const parsed = parseEndpoint(input.baseUrl);
    if (!parsed.ok) throw new UserError("bad_address", parsed.message);
    if (!parsed.loopback && !input.allowRemote) {
      throw new UserError(
        "remote_not_allowed",
        `${parsed.host} is not on this computer. Text you translate would be sent over the network to it. Tick "I understand" to allow that, or use a server on this computer.`,
      );
    }
    if (input.apiKey !== undefined) {
      try {
        if (input.apiKey === "") this.credentials.delete(CREDENTIAL_REF);
        else this.credentials.set(CREDENTIAL_REF, input.apiKey);
      } catch (e) {
        throw new UserError("credential_store", e instanceof Error ? e.message : "The key could not be saved.");
      }
    }
    this.settings.save({ version: 1, provider: { baseUrl: parsed.baseUrl, allowedRemoteHost: parsed.loopback ? null : parsed.host } });
    return this.view();
  }

  /** Why the saved connection cannot be used right now, or null if it can. */
  problem(): string | null {
    return this.view().problem;
  }

  config(): ProviderConfig {
    const { baseUrl } = this.view();
    return {
      id: "local-provider",
      kind: OPENAI_COMPATIBLE_KIND,
      baseUrl,
      ...(this.credentials.has(CREDENTIAL_REF) ? { credentialRef: CREDENTIAL_REF } : {}),
    };
  }

  adapter(): OpenAICompatibleProvider {
    const { allowedRemoteHost } = this.settings.load().provider;
    return new OpenAICompatibleProvider({
      getCredential: (ref) => this.credentials.get(ref),
      allowedRemoteHosts: allowedRemoteHost ? [allowedRemoteHost] : [],
      ...this.adapterOptions,
    });
  }

  /** "Test connection": asks the server for its model list. */
  async test(): Promise<ConnectionTestResult> {
    const view = this.view();
    if (view.problem) return { ok: false, message: view.problem, models: [] };
    const controller = new AbortController();
    try {
      const models = await this.adapter().listModels(this.config(), controller.signal);
      const ids = models.map((m) => m.id);
      return {
        ok: true,
        models: ids,
        message:
          ids.length > 0
            ? `Connected to ${view.host}. The server lists ${ids.length} model${ids.length === 1 ? "" : "s"}. Being listed does not mean a model is loaded: load the one you want in LM Studio.`
            : `Connected to ${view.host}, but it lists no models. In LM Studio, download a model first, then load it.`,
      };
    } catch (e) {
      const err: ProviderError = (e as { providerError?: ProviderError }).providerError ?? toProviderError(e);
      return { ok: false, models: [], message: err.code === "auth" ? `${err.message}` : err.message };
    }
  }
}
