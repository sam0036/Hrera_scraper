import prisma from "../lib/prisma.js";
import { getReraStatusFromExpiry } from "./reraStatus.js";
import { verifyRera } from "./reraVerifier.js";

async function claimJob(jobId) {
  const claimed = await prisma.reraVerificationJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      attempts: { increment: 1 },
      error: null,
    },
  });

  if (claimed.count === 0) return null;

  return prisma.reraVerificationJob.findUnique({
    where: { id: jobId },
    include: { brokerProfile: true },
  });
}

export async function processReraJob(jobId) {
  const job = await claimJob(jobId);
  if (!job) return { processed: false };

  const result = await verifyRera(job.reraNumber, job.state);
  const parsedExpiry = result?.data?.parsedValidity ? new Date(result.data.parsedValidity) : null;
  const status = result.success ? getReraStatusFromExpiry(parsedExpiry) : "FAILED";
  const isValid = status === "VALID";
  const message = result.message || (isValid ? "RERA verified successfully" : "RERA verification failed or expired");

  await prisma.$transaction([
    prisma.brokerProfile.update({
      where: { id: job.brokerProfileId },
      data: {
        reraNumber: job.reraNumber,
        state: job.state,
        isReraVerified: isValid,
        licenseExpiry: parsedExpiry,
        reraExpiryDate: parsedExpiry,
        reraVerificationStatus: status,
        reraLastCheckedAt: new Date(),
        reraVerificationMessage: message,
      },
    }),
    prisma.reraVerificationJob.update({
      where: { id: job.id },
      data: {
        status: result.success ? "SUCCEEDED" : "FAILED",
        result: result.success
          ? JSON.parse(JSON.stringify(result))
          : undefined,
        error: result.success ? null : message,
        completedAt: new Date(),
      },
    }),
  ]);

  return { processed: true, status, success: isValid };
}

export async function processQueuedReraJobs({ limit = 1 } = {}) {
  const jobs = await prisma.reraVerificationJob.findMany({
    where: {
      status: "QUEUED",
      attempts: { lt: 3 },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const results = [];

  for (const job of jobs) {
    results.push(await processReraJob(job.id));
  }

  return { processed: results.length, results };
}