import { HttpRequest } from "@smithy/protocol-http";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Dispatcher } from "undici";

import { UndiciHttpHandler } from "./undici-http-handler";

let server: Server;
let port: number;

function createMockRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return Object.assign(
    new HttpRequest({
      protocol: "http:",
      hostname: "localhost",
      port,
      method: "GET",
      path: "/",
      headers: {},
    }),
    overrides,
  );
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/delay") {
      const ms = parseInt(url.searchParams.get("ms") ?? "1000", 10);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("delayed");
      }, ms);
      return;
    }

    if (url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "x-method": req.method!,
          "x-url": req.url!,
        });
        res.end(Buffer.concat(chunks));
      });
      return;
    }

    if (url.pathname === "/multi-header") {
      // Manually write raw response with duplicate headers
      res.writeHead(200, [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ]);
      res.end("ok");
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("UndiciHttpHandler", () => {
  let handler: UndiciHttpHandler;

  afterEach(() => {
    handler?.destroy();
  });

  describe("constructor and create", () => {
    it("creates a new instance with no options", () => {
      handler = new UndiciHttpHandler();
      expect(handler.metadata).toEqual({ handlerProtocol: "http/1.1" });
    });

    it("creates a new instance with options", () => {
      handler = new UndiciHttpHandler({ requestTimeout: 5000 });
      expect(handler.metadata).toEqual({ handlerProtocol: "http/1.1" });
    });

    it("creates a new instance with a provider function", async () => {
      handler = new UndiciHttpHandler(async () => ({ requestTimeout: 5000 }));
      const { response } = await handler.handle(createMockRequest());
      expect(response.statusCode).toBe(200);
    });

    it("static create returns existing HttpHandler instance", () => {
      handler = new UndiciHttpHandler();
      const result = UndiciHttpHandler.create(handler);
      expect(result).toBe(handler);
    });

    it("static create instantiates from options", () => {
      const result = UndiciHttpHandler.create({ requestTimeout: 1000 });
      expect(result).toBeInstanceOf(UndiciHttpHandler);
      handler = result as UndiciHttpHandler;
    });

    it("static create instantiates with no arguments", () => {
      const result = UndiciHttpHandler.create();
      expect(result).toBeInstanceOf(UndiciHttpHandler);
      handler = result as UndiciHttpHandler;
    });
  });

  describe("handle", () => {
    it("makes a basic GET request", async () => {
      handler = new UndiciHttpHandler();
      const { response } = await handler.handle(createMockRequest());
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("sends request body on POST", async () => {
      handler = new UndiciHttpHandler();
      const body = "hello world";
      const { response } = await handler.handle(
        createMockRequest({
          method: "POST",
          path: "/echo",
          body,
          headers: { "content-type": "text/plain" },
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-method"]).toBe("POST");
      const text = await new Response(response.body).text();
      expect(text).toBe("hello world");
    });

    it("sends Buffer body", async () => {
      handler = new UndiciHttpHandler();
      const body = Buffer.from("buffer body");
      const { response } = await handler.handle(
        createMockRequest({
          method: "POST",
          path: "/echo",
          headers: { "content-type": "application/octet-stream" },
          body,
        }),
      );
      expect(response.statusCode).toBe(200);
      const text = await new Response(response.body).text();
      expect(text).toBe("buffer body");
    });

    it("appends query string to path", async () => {
      handler = new UndiciHttpHandler();
      const { response } = await handler.handle(
        createMockRequest({
          path: "/echo",
          query: { foo: "bar", baz: "qux" },
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-url"]).toContain("foo=bar");
      expect(response.headers["x-url"]).toContain("baz=qux");
    });

    it("joins multi-value response headers with comma", async () => {
      handler = new UndiciHttpHandler();
      const { response } = await handler.handle(
        createMockRequest({ path: "/multi-header" }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBe("a=1, b=2");
    });

    it("handles fragment in path", async () => {
      handler = new UndiciHttpHandler();
      const { response } = await handler.handle(
        createMockRequest({
          path: "/echo",
          fragment: "section1",
        } as any),
      );
      expect(response.statusCode).toBe(200);
    });
  });

  describe("abort signal", () => {
    it("throws AbortError if signal is already aborted", async () => {
      handler = new UndiciHttpHandler();
      const controller = new AbortController();
      controller.abort();
      await expect(
        handler.handle(createMockRequest(), {
          abortSignal: controller.signal as any,
        }),
      ).rejects.toThrow("Request aborted");
    });

    it("throws AbortError when signal is aborted during request", async () => {
      handler = new UndiciHttpHandler();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await expect(
        handler.handle(createMockRequest({ path: "/delay?ms=5000" }), {
          abortSignal: controller.signal as any,
        }),
      ).rejects.toThrow();
    });
  });

  describe("timeouts", () => {
    it("uses requestTimeout from options", async () => {
      handler = new UndiciHttpHandler({ requestTimeout: 50 });
      await expect(
        handler.handle(createMockRequest({ path: "/delay?ms=5000" })),
      ).rejects.toThrow();
    });

    it("uses requestTimeout from handle options", async () => {
      handler = new UndiciHttpHandler();
      await expect(
        handler.handle(createMockRequest({ path: "/delay?ms=5000" }), {
          requestTimeout: 50,
        }),
      ).rejects.toThrow();
    });
  });

  describe("external dispatcher", () => {
    it("uses provided dispatcher", async () => {
      const mockDispatcher = {
        request: vi.fn().mockResolvedValue({
          statusCode: 201,
          headers: { "x-custom": "value" },
          body: null,
        }),
        destroy: vi.fn(),
      } as unknown as Dispatcher;

      handler = new UndiciHttpHandler({ dispatcher: mockDispatcher });
      const { response } = await handler.handle(createMockRequest());
      expect(response.statusCode).toBe(201);
      expect(response.headers["x-custom"]).toBe("value");
      expect(mockDispatcher.request).toHaveBeenCalledOnce();
    });

    it("does not destroy external dispatcher on handler destroy", () => {
      const mockDispatcher = {
        destroy: vi.fn(),
      } as unknown as Dispatcher;

      handler = new UndiciHttpHandler({ dispatcher: mockDispatcher });
      handler.destroy();
      expect(mockDispatcher.destroy).not.toHaveBeenCalled();
    });
  });

  describe("expect header", () => {
    it("strips Expect header before sending to undici", async () => {
      const mockDispatcher = {
        request: vi.fn().mockResolvedValue({
          statusCode: 200,
          headers: {},
          body: null,
        }),
        destroy: vi.fn(),
      } as unknown as Dispatcher;

      handler = new UndiciHttpHandler({ dispatcher: mockDispatcher });
      await handler.handle(
        createMockRequest({
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            Expect: "100-continue",
          },
        }),
      );

      const callArgs = (mockDispatcher.request as any).mock.calls[0][0];
      expect(callArgs.headers).not.toHaveProperty("Expect");
      expect(callArgs.headers).not.toHaveProperty("expect");
    });

    it("strips lowercase expect header", async () => {
      const mockDispatcher = {
        request: vi.fn().mockResolvedValue({
          statusCode: 200,
          headers: {},
          body: null,
        }),
        destroy: vi.fn(),
      } as unknown as Dispatcher;

      handler = new UndiciHttpHandler({ dispatcher: mockDispatcher });
      await handler.handle(
        createMockRequest({
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            expect: "100-continue",
          },
        }),
      );

      const callArgs = (mockDispatcher.request as any).mock.calls[0][0];
      expect(callArgs.headers).not.toHaveProperty("Expect");
      expect(callArgs.headers).not.toHaveProperty("expect");
    });
  });

  describe("destroy", () => {
    it("destroys internal dispatcher", async () => {
      handler = new UndiciHttpHandler();
      // Trigger dispatcher creation
      await handler.handle(createMockRequest());
      // Should not throw
      handler.destroy();
    });

    it("is safe to call multiple times", () => {
      handler = new UndiciHttpHandler();
      handler.destroy();
      handler.destroy();
    });
  });

  describe("updateHttpClientConfig / httpHandlerConfigs", () => {
    it("returns empty object before first request", () => {
      handler = new UndiciHttpHandler({ requestTimeout: 1000 });
      expect(handler.httpHandlerConfigs()).toEqual({});
    });

    it("returns config after first request", async () => {
      handler = new UndiciHttpHandler({ requestTimeout: 1000 });
      await handler.handle(createMockRequest());
      const configs = handler.httpHandlerConfigs();
      expect(configs.requestTimeout).toBe(1000);
    });

    it("updates config", async () => {
      handler = new UndiciHttpHandler({ requestTimeout: 1000 });
      await handler.handle(createMockRequest());
      handler.updateHttpClientConfig("requestTimeout", 2000);
      // Config is reset, need another request to resolve
      await handler.handle(createMockRequest());
      expect(handler.httpHandlerConfigs().requestTimeout).toBe(2000);
    });
  });
});
