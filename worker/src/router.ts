// Compatibility barrel for the host-neutral route table. The Node dispatcher
// owns HTTP dispatch; no Workers fetch handler or runtime bindings live here.
export {
  type AssetFetcher,
  type AssetMissDeps,
  assetMiss,
  createRouteTable,
  INTERNAL_HEADER_PREFIX,
  invokeRoute,
  matchRoute,
  matchSpaRoute,
  REQUEST_ID_HEADER,
  ROUTES,
  type RouteMatch,
  type RouteTable,
  safeAssetPath,
  servesSpaIndex,
  withRequestId,
} from './http/routes';
