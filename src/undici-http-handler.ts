import type { HttpHandler, HttpRequest } from "@smithy/protocol-http";
import { HttpResponse } from "@smithy/protocol-http";
import { buildQueryString } from "@smithy/querystring-builder";
import type { HttpHandlerOptions, Logger, Provider } from "@smithy/types";
import { Agent, Dispatcher } from "undici";

/**
 * Options for the UndiciHttpHandler.
 */
export interface UndiciHttpHandlerOptions {
  /**
   * The maximum time in milliseconds that the connection phase of a request
   * may take before the connection attempt is abandoned.
   *
   * Mapped to undici's `connect.timeout`.
   */
  connectionTimeout?: number;

  /**
   * The maximum time in milliseconds that a request may take.
   * Mapped to undici's `headersTimeout` + `bodyTimeout`.
   */
  requestTimeout?: number;

  /**
   * Maximum number of connections per origin.
   * Defaults to 50 (matching NodeHttpHandler's default maxSockets).
   */
  maxConnectionsPerOrigin?: number;

  /**
   * An existing undici Dispatcher (Agent, Pool, Client, etc.) to use.
   * When provided, connectionTimeout, requestTimeout, and maxConnectionsPerOrigin
   * are ignored since the dispatcher is externally managed.
   */
  dispatcher?: Dispatcher;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

/**
 * An HTTP handler that uses undici instead of Node.js native http/https modules.
 * Drop-in replacement for `NodeHttpHandler` from `@smithy/node-http-handler`.
 */
export class UndiciHttpHandler
  implements HttpHandler<UndiciHttpHandlerOptions>
{
  private config?: UndiciHttpHandlerOptions;
  private configProvider: Promise<UndiciHttpHandlerOptions>;
  private dispatcher?: Dispatcher;
  private externalDispatcher = false;

  public readonly metadata = { handlerProtocol: "http/1.1" };

  /**
   * Returns the input if it is an HttpHandler of any class,
   * or instantiates a new instance of this handler.
   */
  public static create(
    instanceOrOptions?:
      | HttpHandler<any>
      | UndiciHttpHandlerOptions
      | Provider<UndiciHttpHandlerOptions | void>,
  ) {
    if (typeof (instanceOrOptions as any)?.handle === "function") {
      return instanceOrOptions as HttpHandler<any>;
    }
    return new UndiciHttpHandler(instanceOrOptions as UndiciHttpHandlerOptions);
  }

  constructor(
    options?:
      | UndiciHttpHandlerOptions
      | Provider<UndiciHttpHandlerOptions | void>,
  ) {
    this.configProvider = new Promise((resolve, reject) => {
      if (typeof options === "function") {
        options()
          .then((_options) => resolve(this.resolveConfig(_options)))
          .catch(reject);
      } else {
        resolve(this.resolveConfig(options));
      }
    });
  }

  private resolveConfig(
    options?: UndiciHttpHandlerOptions | void,
  ): UndiciHttpHandlerOptions {
    const resolved: UndiciHttpHandlerOptions = { ...options };
    if (resolved.dispatcher) {
      this.externalDispatcher = true;
      this.dispatcher = resolved.dispatcher;
    }
    return resolved;
  }

  private getOrCreateDispatcher(config: UndiciHttpHandlerOptions): Dispatcher {
    if (this.dispatcher) {
      return this.dispatcher;
    }

    const connectTimeout = config.connectionTimeout ?? 0;
    const bodyTimeout = config.requestTimeout ?? 0;
    const headersTimeout = config.requestTimeout ?? 0;
    const connections = config.maxConnectionsPerOrigin ?? 50;

    this.dispatcher = new Agent({
      connections,
      bodyTimeout: bodyTimeout || undefined,
      headersTimeout: headersTimeout || undefined,
      connect: {
        timeout: connectTimeout || undefined,
        keepAlive: true,
      },
    });

    return this.dispatcher;
  }

  public destroy(): void {
    if (this.dispatcher && !this.externalDispatcher) {
      this.dispatcher.destroy();
      this.dispatcher = undefined;
    }
  }

  public async handle(
    request: HttpRequest,
    { abortSignal, requestTimeout }: HttpHandlerOptions = {},
  ): Promise<{ response: HttpResponse }> {
    if (!this.config) {
      this.config = await this.configProvider;
    }

    const config = this.config;
    const dispatcher = this.getOrCreateDispatcher(config);

    if (abortSignal?.aborted) {
      throw buildAbortError();
    }

    // Build the full URL
    const queryString = buildQueryString(request.query || {});
    let path = request.path;
    if (queryString) {
      path += `?${queryString}`;
    }
    if (request.fragment) {
      path += `#${request.fragment}`;
    }

    let auth: string | undefined;
    if (request.username != null || request.password != null) {
      const username = request.username ?? "";
      const password = request.password ?? "";
      auth = `${username}:${password}`;
    }

    const port = request.port ? `:${request.port}` : "";
    let origin = `${request.protocol}//${request.hostname}${port}`;
    if (auth) {
      origin = `${request.protocol}//${auth}@${request.hostname}${port}`;
    }

    // undici natively supports string | Buffer | Uint8Array | Readable | AsyncIterable as body.
    // Pass through directly to avoid buffering streams into memory.
    const body = request.body ?? null;

    // undici does not support the Expect header through its request() API.
    // The AWS SDK adds "Expect: 100-continue" for large request bodies, but
    // undici sends the body immediately without waiting for a 100 Continue
    // response, so the header is unnecessary and must be removed.
    delete request.headers["Expect"];
    delete request.headers["expect"];

    // Build undici request options
    const effectiveTimeout = requestTimeout ?? config.requestTimeout ?? 0;
    const requestOptions: Dispatcher.RequestOptions = {
      origin,
      path,
      method: request.method as Dispatcher.HttpMethod,
      headers: request.headers,
      body,
      headersTimeout: effectiveTimeout || undefined,
      bodyTimeout: effectiveTimeout || undefined,
      signal: abortSignal as AbortSignal | undefined,
    };

    try {
      const {
        statusCode,
        headers: responseHeaders,
        body: responseBody,
      } = await dispatcher.request(requestOptions);

      // Transform undici headers (Record<string, string | string[]>) to HeaderBag (Record<string, string>)
      const transformedHeaders: Record<string, string> = {};
      for (const key in responseHeaders) {
        const value = responseHeaders[key];
        if (value !== undefined) {
          transformedHeaders[key] = Array.isArray(value)
            ? value.join(", ")
            : value;
        }
      }

      const httpResponse = new HttpResponse({
        statusCode,
        headers: transformedHeaders,
        body: responseBody,
      });

      return { response: httpResponse };
    } catch (err: any) {
      if (err?.name === "AbortError" || err?.code === "UND_ERR_ABORTED") {
        throw buildAbortError();
      }
      if (
        err?.code === "UND_ERR_HEADERS_TIMEOUT" ||
        err?.code === "UND_ERR_BODY_TIMEOUT" ||
        err?.code === "UND_ERR_CONNECT_TIMEOUT"
      ) {
        throw Object.assign(new Error(`Request timeout: ${err.message}`), {
          name: "TimeoutError",
        });
      }
      throw err;
    }
  }

  public updateHttpClientConfig(
    key: keyof UndiciHttpHandlerOptions,
    value: UndiciHttpHandlerOptions[typeof key],
  ): void {
    this.config = undefined;
    this.configProvider = this.configProvider.then((config) => ({
      ...config,
      [key]: value,
    }));
  }

  public httpHandlerConfigs(): UndiciHttpHandlerOptions {
    return this.config ?? {};
  }
}

function buildAbortError(): Error {
  return Object.assign(new Error("Request aborted"), {
    name: "AbortError",
  });
}
