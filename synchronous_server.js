import express from "express";
// import cors from "cors";
import dotenv from "dotenv";

import { resend } from "./lib/resend.js";
import EmailJob from "./models/EmailJob.js";

dotenv.config({ path: "./.env" });

const app = express();

app.use(express.json());

app.post("/emails", async (req, res) => {
  try {
    const { email, subject, body, idempotencyKey } = req.body;

    // Check if this request has already been processed
    const existingEmailJob = await EmailJob.findOne({
      idempotencyKey: idempotencyKey,
    });

    if (existingEmailJob) {
      return res.status(200).json({
        success: true,
        message: "The work has already been done.",
        jobId: existingEmailJob._id,
      });
    }

    // Create a new email job
    const newJob = new EmailJob({
      to: email,
      subject: subject,
      body: body,
      idempotencyKey: idempotencyKey,
      status: "pending",
    });

    /*
      We save the job before calling the provider.

      Why?

      Node.js is asynchronous. If the user double-clicks the Send button
      or retries within milliseconds, two HTTP requests can execute in parallel.

      MongoDB processes inserts one after another.

      The first request inserts successfully.
      The second request tries to insert the same idempotencyKey.

      Since the schema has unique: true, MongoDB throws:
      Error Code 11000 = Duplicate Key Error
    */

    try {
      await newJob.save();
    } catch (dbError) {
      if (dbError.code === 11000) {
        const parallelExistingJob = await EmailJob.findOne({
          idempotencyKey: idempotencyKey,
        });

        return res.status(200).json({
          success: true,
          message: "The work has already been done.",
          jobId: parallelExistingJob._id,
        });
      }

      throw dbError;
    }

    // Send email using Resend
    try {
      const emailResponse = await resend.emails.send({
        from: "Acme <onboarding@resend.dev>",
        to: email,
        subject: subject,
        html: body,
      });

      newJob.attempts += 1;

      if (emailResponse.data?.id) {
        newJob.status = "sent";
        await newJob.save();

        return res.status(200).json({
          success: true,
          message: "Email sent successfully",
          jobId: newJob._id,
        });
      } else {
        newJob.status = "failed";
        newJob.lastError =
          emailResponse.error?.message || "Unknown provider error";

        await newJob.save();

        return res.status(400).json({
          success: false,
          message: "Email provider rejected request",
          error: newJob.lastError,
          jobId: newJob._id,
        });
      }
    } catch (error) {
      newJob.attempts += 1;
      newJob.status = "failed";
      newJob.lastError = error.message || "Unknown provider error";

      await newJob.save();

      return res.status(500).json({
        success: false,
        message: "Failed to dispatch email execution",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("Error sending email:", error);

    return res.status(500).json({
      message: "Error sending email",
    });
  }
});

export { app };import express from "express";
// import cors from "cors";
import dotenv from "dotenv";

import { resend } from "./lib/resend.js";
import EmailJob from "./models/EmailJob.js";

dotenv.config({ path: "./.env" });

const app = express();

app.use(express.json());

app.post("/emails", async (req, res) => {
  try {
    const { email, subject, body, idempotencyKey } = req.body;

    // Check if this request has already been processed
    const existingEmailJob = await EmailJob.findOne({
      idempotencyKey: idempotencyKey,
    });

    if (existingEmailJob) {
      return res.status(200).json({
        success: true,
        message: "The work has already been done.",
        jobId: existingEmailJob._id,
      });
    }

    // Create a new email job
    const newJob = new EmailJob({
      to: email,
      subject: subject,
      body: body,
      idempotencyKey: idempotencyKey,
      status: "pending",
    });

    /*
      We save the job before calling the provider. because
      Node.js is asynchronous. If the user double-clicks the Send button
      or retries within milliseconds, two HTTP requests can execute in parallel.
      MongoDB processes inserts one after another.
      The first request inserts successfully.
      The second request tries to insert the same idempotencyKey.
      Since the schema has unique: true, MongoDB throws:
      Error Code 11000 = Duplicate Key Error
    */

    try {
      await newJob.save();
    } catch (dbError) {
      if (dbError.code === 11000) {
        const parallelExistingJob = await EmailJob.findOne({
          idempotencyKey: idempotencyKey,
        });

        return res.status(200).json({
          success: true,
          message: "The work has already been done.",
          jobId: parallelExistingJob._id,
        });
      }

      throw dbError;
    }

    // Send email using Resend
    try {
      const emailResponse = await resend.emails.send({
        from: "Acme <onboarding@resend.dev>",
        to: email,
        subject: subject,
        html: body,
      });

      newJob.attempts += 1;

      if (emailResponse.data?.id) {
        newJob.status = "sent";
        await newJob.save();

        return res.status(200).json({
          success: true,
          message: "Email sent successfully",
          jobId: newJob._id,
        });
      } else {
        newJob.status = "failed";
        newJob.lastError =
          emailResponse.error?.message || "Unknown provider error";

        await newJob.save();

        return res.status(400).json({
          success: false,
          message: "Email provider rejected request",
          error: newJob.lastError,
          jobId: newJob._id,
        });
      }
    } catch (error) {
      newJob.attempts += 1;
      newJob.status = "failed";
      newJob.lastError = error.message || "Unknown provider error";

      await newJob.save();

      return res.status(500).json({
        success: false,
        message: "Failed to dispatch email execution",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("Error sending email:", error);

    return res.status(500).json({
      message: "Error sending email",
    });
  }
});

export { app };