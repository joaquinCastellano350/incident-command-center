import { ReviewQueueSchema } from '@incident-command-center/contracts';
import { ReviewQueueView } from './review-queue';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage() {
  const response = await fetch(
    `${process.env.API_INTERNAL_BASE_URL}/api/v1/review-tasks`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw new Error('Review Task request failed');
  return (
    <ReviewQueueView
      apiBaseUrl={process.env.PUBLIC_API_BASE_URL!}
      initialQueue={ReviewQueueSchema.parse(await response.json())}
    />
  );
}
