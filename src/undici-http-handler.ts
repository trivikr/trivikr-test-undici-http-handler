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
   * An existing undici Dispatcher (Agent, Pool, Client, etc.) to use.
   */
  dispatcher?: Dispatcher;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

/**
 * An HTTP handler that uses undici instead of Node.js native http/https modules.
 * Smithy-compatible request handler backed by undici.
 */
export class UndiciHttpHandler
  implements HttpHandler<UndiciHttpHandlerOptions>
{
  private config?: UndiciHttpHandlerOptions;
  private configProvider: Promise<UndiciHttpHandlerOptions>;
  private dispatcher?: Dispatcher;
  private externalDispatcher = false;

  public readonly metadata = { handlerProtocol: "http/1.1" };

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
    return resolved;
  }

  private getOrCreateDispatcher(): Dispatcher {
    if (this.dispatcher) {
      return this.dispatcher;
    }

    this.dispatcher = new Agent();

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

    const dispatcher = this.getOrCreateDispatcher();

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

    const headersTimeout =
      requestTimeout !== undefined ? requestTimeout || undefined : undefined;
    const bodyTimeout =
      requestTimeout !== undefined ? requestTimeout || undefined : undefined;

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
      }

      return updated;
    });
  }

  public httpHandlerConfigs(): UndiciHttpHandlerOptions {
    return this.config ?? {};
  }
}
