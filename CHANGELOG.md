# @trivikr-test/undici-http-handler

## 0.6.0

### Minor Changes

- Deprecated in favor of `@smithy/undici-http-handler`. The `UndiciHttpHandler` class and `UndiciHttpHandlerOptions` interface are marked with `@deprecated` JSDoc tags, and a Node.js `DeprecationWarning` is emitted the first time `UndiciHttpHandler` is instantiated. ([6dec2b3b99a79fa5baa0cbecde73b40f8be80657](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/6dec2b3b99a79fa5baa0cbecde73b40f8be80657))

## 0.5.0

### Minor Changes

- Support bidirectional streaming by allowing HTTP/2 connections ([b38906086067981ef585f226cf58deb855f651c7](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/b38906086067981ef585f226cf58deb855f651c7))

## 0.4.0

### Minor Changes

- Replace TypeScript's compile-time `private` keyword with native ECMAScript private class fields (#) for true runtime encapsulation. ([f9355e2e941d6366de045e13758f25525483b6ef](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/f9355e2e941d6366de045e13758f25525483b6ef))

## 0.3.2

### Patch Changes

- Support streaming body in UndiciHttpHandler ([e93e7d7bbe7f70a1155bdceff87164d902c4ebde](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/e93e7d7bbe7f70a1155bdceff87164d902c4ebde))

## 0.3.1

### Patch Changes

- Exclude test files in compilation ([4b15aadb3547baa1eb53fd6960cf09889c3ef876](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/4b15aadb3547baa1eb53fd6960cf09889c3ef876))
- Use @tsconfig/node20 in tsconfig ([c3ce414615e1bb106074d8fc11bee3a179c96306](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/c3ce414615e1bb106074d8fc11bee3a179c96306))

## 0.3.0

### Minor Changes

- Remove `static create()` factory method and async config provider ([b3c15732c08814095cb608d4e5ab33bb73c9e1d2](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/b3c15732c08814095cb608d4e5ab33bb73c9e1d2))

### Patch Changes

- Validate dispatcher in updateHttpClientConfig with early return ([ba7313ad80c8371f39d7d6a892a80a58d5f761dc](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/ba7313ad80c8371f39d7d6a892a80a58d5f761dc))

## 0.2.0

### Minor Changes

- Remove redundant undici handler config options ([20f20665943266ebd98de501dd4130b94ae8b301](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/20f20665943266ebd98de501dd4130b94ae8b301))

## 0.1.4

### Patch Changes

- Optimize handle() hot path in UndiciHttpHandler ([7cf18a420d4a4d2fc366589568a2276ac53485e9](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/7cf18a420d4a4d2fc366589568a2276ac53485e9))

## 0.1.3

### Patch Changes

- Rethrow errors with code 'UND_ERR_SOCKET' as RequestTimeout ([f41e01b548309f8b6ca9e219c7cc4f8210c54fe2](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/f41e01b548309f8b6ca9e219c7cc4f8210c54fe2))

## 0.1.2

### Patch Changes

- Strip Expect header to prevent NotSupportedError in undici ([1755fe3b78df97dc64c588b4af7ce8641ed10f00](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/1755fe3b78df97dc64c588b4af7ce8641ed10f00))

## 0.1.1

### Patch Changes

- Validating automated publish through changesets and GitHub Actions ([a6719d3dd622aa973451083bdfac04f2a7dc8b7c](https://github.com/trivikr/trivikr-test-undici-http-handler/commit/a6719d3dd622aa973451083bdfac04f2a7dc8b7c))
