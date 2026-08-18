import { PineStocktakeWorkflow } from '@/components/pine-stocktake/PineStocktakeWorkflow';
import { PineMissionSetup } from '@/components/pine-stocktake/PineMissionSetup';

export default async function PineStocktakePage({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<{ orthomosaicId?: string }> }) {
  const { jobId } = await params;
  if (jobId === 'new') {
    const query = await searchParams;
    return <PineMissionSetup orthomosaicId={query.orthomosaicId} />;
  }
  return <PineStocktakeWorkflow jobId={jobId} />;
}
