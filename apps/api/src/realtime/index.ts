/** Public surface of the realtime gateway (PROJECTPLAN.md §4.5, V3-P7a). */
export {
  createRealtimeGateway,
  userRoom,
  assetRoom,
  portfolioRoom,
  REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS,
  type RealtimeGateway,
  type RealtimeGatewayDeps,
  type RealtimePrincipal,
  type RealtimeSessionPrincipal,
  type RealtimePersonalPrincipal,
  type RealtimeOAuthPrincipal,
} from './gateway';
