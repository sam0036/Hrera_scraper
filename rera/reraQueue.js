import prisma from "../lib/prisma.js";

export async function queueReraVerificationJob({ brokerProfile, requestedBy, reraNumber, state }) {
  return prisma.reraVerificationJob.create({
    data: {
      brokerProfileId: brokerProfile.id,
      requestedBy,
      reraNumber,
      state,
      status: "QUEUED",
    },
  });
}