import { EmailJob } from "./models/EmailJob.js";
import {emailQueue} from './queue.js';
import {Worker,QueueEvents} from 'bullmq';
import connectDB from './db/index.js';
import dotenv from 'dotenv';
import { resend } from "./lib/resend.js";

dotenv.config({path: './.env'});
connectDB();

// const queueEvents = new QueueEvents('emailQueue', { connection: emailQueue.opts.connection });

// this job is coming fromt the redis queue
const worker = new Worker('emailQueue', async (job) => {

    const { to, subject, body,mongoId } = job.data;
    if(!to || !subject || !body || !mongoId ) {
        throw new Error('Missing required fields in job data');
    }

    const emailJob = await EmailJob.findById(mongoId);
    if(!emailJob){
        throw new Error('Email job not found in database');
        // in here we throw error so that the job will be retried by bullmq, if we return res.status(404) then the job will be marked as completed and will not be retried
    }

    emailJob.attempts += 1;
    await emailJob.save();

    try{
        const emailResponse = await resend.emails.send({
            from: 'Acme <onboarding@resend.dev>',
            to: to,
            subject: subject,
            html:body
        });

        if(emailResponse.data?.id){
            emailJob.status = 'sent';
            emailJob.providerMessageId = emailResponse.data.id; // this we are stroing for server to server verificaation via webhooks 
            console.log('email messageProviderId is :',emailResponse.data.id);
            await emailJob.save();
            return{
                success: true,
                jobId:emailJob._id,
                providerMessageId:emailResponse.data.id,
            }; // in here we do not return res.status(200) because this is a worker and not an express route handler, we just want to mark the job as completed and not send any response back to the client
            // return res.status(200)  
        }else{
            throw new Error(emailResponse.error?.message || 'Unknown provider error');
        }

    }catch(error){
        emailJob.lastError = error?.message || 'Unknown provider error';
        // await emailJob.save();
        const maxAttempts = job.opts.attempts || 5;

        // job.attemptsMade is a property provided by bullmq that keeps track of how many times the job has been attempted, including the current attempt. 
        // job.attemptsMade starts at 0 and add 1 for each retry, so if we want to check if the job has reached the max attempts, we need to add 1 to it.
        if(job.attemptsMade + 1 >= maxAttempts){
            emailJob.status = 'failed';
            await emailJob.save();
            console.log(`Job has retried max times`);
        }
        else{
            await emailJob.save();
        }
        throw error;
    }
}, 
{
    connection: emailQueue.opts.connection,
    limiter:{  // this is for limiting email sent , so that not to exceed the limit to the service provider 
        max:10,
        duration:1000 // 10 emials per sec
    }
});

