import { limiter } from '@/lib/limiter'

/**
 * GET /api/cost
 *
 * Returns the current cost report across all periods and models.
 * Useful for dashboards, alerting, and cost-awareness UIs.
 */
export async function GET() {
  return Response.json(limiter.getCostReport())
}
