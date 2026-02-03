"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type WorkflowStepId = "sam3" | "export" | "training" | "inference";

interface WorkflowGuideProps {
  current: WorkflowStepId;
}

const WORKFLOW_STEPS: Array<{
  id: WorkflowStepId;
  title: string;
  description: string;
  href: string;
  cta: string;
}> = [
  {
    id: "sam3",
    title: "SAM3 Rapid Training",
    description: "Generate candidate detections with concept propagation.",
    href: "/training-hub",
    cta: "Open SAM3 Hub",
  },
  {
    id: "export",
    title: "Export Detections",
    description: "Review results and export detections for training.",
    href: "/export",
    cta: "Open Export",
  },
  {
    id: "training",
    title: "YOLO Training",
    description: "Build datasets and train your custom model.",
    href: "/training#training",
    cta: "Open Training",
  },
  {
    id: "inference",
    title: "Run Inference",
    description: "Apply the model and review detections.",
    href: "/training#inference",
    cta: "Open Inference",
  },
];

export function WorkflowGuide({ current }: WorkflowGuideProps) {
  const currentIndex = WORKFLOW_STEPS.findIndex((step) => step.id === current);
  const nextStep = currentIndex >= 0 ? WORKFLOW_STEPS[currentIndex + 1] : null;

  return (
    <Card className="mb-6 border-blue-200 bg-gradient-to-r from-blue-50 to-green-50">
      <CardHeader>
        <CardTitle className="text-lg">Workflow Guide</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {WORKFLOW_STEPS.map((step, index) => {
            const isCurrent = step.id === current;
            return (
              <div
                key={step.id}
                className={`rounded-lg border p-3 ${
                  isCurrent
                    ? "border-blue-400 bg-white shadow-sm"
                    : "border-gray-200 bg-white/70"
                }`}
              >
                <p className="text-xs font-semibold text-gray-500">
                  Step {index + 1}
                </p>
                <p className="font-medium text-gray-900">{step.title}</p>
                <p className="text-xs text-gray-600">{step.description}</p>
                <Button asChild size="sm" variant={isCurrent ? "default" : "outline"} className="mt-2">
                  <Link href={step.href}>{step.cta}</Link>
                </Button>
              </div>
            );
          })}
        </div>
        {nextStep && (
          <div className="flex justify-end">
            <Button asChild>
              <Link href={nextStep.href}>Next: {nextStep.title}</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
