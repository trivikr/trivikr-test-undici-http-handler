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

  // Cached timeout values resolved from config, avoids repeated nullish
  // coalescing on every handle() call.
  private resolvedBodyTimeout: number | undefined;
  private resolvedHeadersTimeout: number | undefined;

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
    if (typeof options === "function") {
      this.configProvider = options().then((_options) =>
        this.resolveConfig(_options),
      );
    } else {
      // Synchronous path: resolve config immediately and cache a
      // pre-settled promise so the first handle() avoids a microtask.
      const resolved = this.resolveConfig(options);
      this.config = resolved;
      this.configProvider = Promise.resolve(resolved);
    }
  }

  private resolveConfig(
    options?: UndiciHttpHandlerOptions | void,
  ): UndiciHttpHandlerOptions {
    const resolved: UndiciHttpHandlerOptions = { ...options };
    if (resolved.dispatcher) {
      this.externalDispatcher = true;
      this.dispatcher = resolved.dispatcher;
    }
    // Pre-compute timeout values so handle() doesn't repeat this work.
    const timeout = resolved.requestTimeout ?? 0;
    this.resolvedBodyTimeout = timeout || undefined;
    this.resolvedHeadersTimeout = timeout || undefined;
    return resolved;
  }

  private getOrCreateDispatcher(config: UndiciHttpHandlerOptions): Dispatcher {
    if (this.dispatcher) {
      return this.dispatcher;
    }

    const connectTimeout = config.connectionTimeout ?? 0;
    const connections = config.maxConnectionsPerOrigin ?? 50;

    this.dispatcher = new Agent({
      connections,
      bodyTimeout: this.resolvedBodyTimeout,
      headersTimeout: this.resolvedHeadersTimeout,
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

    const dispatcher = this.getOrCreateDispatcher(this.config);

    if (abortSignal?.aborted) {
      throw Object.assign(new Error("Request aborted"), {
        name: "AbortError",
      });
    }

    // Build path with query string — skip buildQueryString when query is undefined.
    let path = request.path;
    if (request.query) {
      const queryString = buildQueryString(request.query);
      if (queryString) {
        path += `?${queryString}`;
      }
    }
    if (request.fragment) {
      path += `#${request.fragment}`;
    }

    // Build origin string.
    const port = request.port ? `:${request.port}` : "";
    let origin: string;
    if (request.username != null || request.password != null) {
      const username = request.username ?? "";
      const password = request.password ?? "";
      origin = `${request.protocol}//${username}:${password}@${request.hostname}${port}`;
    } else {
      origin = `${request.protocol}//${request.hostname}${port}`;
    }

    // Strip the Expect header — undici does not support 100-continue and
    // sends the body immediately, so the header is unnecessary.
    const headers = request.headers;
    if ("Expect" in headers) delete headers["Expect"];
    if ("expect" in headers) delete headers["expect"];

    // Compute per-request timeout only when the caller overrides it;
    // otherwise fall back to the pre-resolved config values.
    let headersTimeout: number | undefined;
    let bodyTimeout: number | undefined;
    if (requestTimeout !== undefined) {
      headersTimeout = requestTimeout || undefined;
      bodyTimeout = requestTimeout || undefined;
    } else {
      headersTimeout = this.resolvedHeadersTimeout;
      bodyTimeout = this.resolvedBodyTimeout;
    }

    try {
      const {
        statusCode,
        headers: responseHeaders,
        body: responseBody,
      } = await dispatcher.request({
        origin,
        path,
        method: request.method as Dispatcher.HttpMethod,
        headers,
        body: request.body ?? null,
        headersTimeout,
        bodyTimeout,
        signal: abortSignal as AbortSignal | undefined,
      });

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
      if (err?.code === "UND_ERR_ABORTED") {
        throw Object.assign(err, { name: "AbortError" });
      }

      if (
        err?.code === "UND_ERR_BODY_TIMEOUT" ||
        err?.code === "UND_ERR_CONNECT_TIMEOUT" ||
        err?.code === "UND_ERR_HEADERS_TIMEOUT"
      ) {
        throw Object.assign(err, { name: "TimeoutError" });
      }

      if (err?.code === "UND_ERR_SOCKET") {
        throw Object.assign(err, { name: "RequestTimeout" });
      }
      throw err;
    }
  }

  public updateHttpClientConfig(
    key: keyof UndiciHttpHandlerOptions,
    value: UndiciHttpHandlerOptions[typeof key],
  ): void {
    this.config = undefined;
    this.configProvider = this.configProvider.then((config) => {
      const updated = { ...config, [key]: value };
      // Re-compute cached timeout values.
      const timeout = updated.requestTimeout ?? 0;
      this.resolvedBodyTimeout = timeout || undefined;
      this.resolvedHeadersTimeout = timeout || undefined;

      if (key === "dispatcher") {
        // Tear down the old internal dispatcher before switching.
        if (this.dispatcher && !this.externalDispatcher) {
          this.dispatcher.destroy();
        }
        if (value) {
          this.dispatcher = value as Dispatcher;
          this.externalDispatcher = true;
        } else {
          this.dispatcher = undefined;
          this.externalDispatcher = false;
        }
      } else if (
        key === "connectionTimeout" ||
        key === "maxConnectionsPerOrigin"
      ) {
        // These options are baked into the Agent at creation time, so the
        // existing internal dispatcher must be discarded so that
        // getOrCreateDispatcher() builds a new one with the updated values.
        if (this.dispatcher && !this.externalDispatcher) {
          this.dispatcher.destroy();
          this.dispatcher = undefined;
        }
      }

      return updated;
    });
  }

  public httpHandlerConfigs(): UndiciHttpHandlerOptions {
    return this.config ?? {};
  }
}
