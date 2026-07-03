import express from 'express';
// import cors from 'cors';
import dotenv from 'dotenv';
import { resend } from './lib/resend.js';
import {EmailJob} from './models/EmailJob.js';
import {emailQueue} from './queue.js';

dotenv.config({path: './.env'});

const app = express();
app.use(express.json());

app.post('/emails', async (req,res)=>{
    try{
        const { email, subject, body , idempotencyKey } = req.body;

        if(!email || !subject || !body || !idempotencyKey){
            return res.status(400).json({
                success: false,
                message: 'Missing required fields',
            })
        }

        const existingEmailJob = await EmailJob.findOne({ idempotencyKey: idempotencyKey });

        if(existingEmailJob){
            return res.status(200).json({
                success: true,
                message: 'The work has already been done.',
                jobId:existingEmailJob._id,
            })
        }

        const newJob = new EmailJob({
            to: email,
            subject: subject,
            body: body,
            idempotencyKey: idempotencyKey,
            status: 'pending',
        })

        // await newJob.save();
        // as nodeJS is asynchronous, if i double-click the send button,or i retry a failed req within milliseconds, two HTTP req will run in parallel
        // as mongoDB is single threaded at doucmnet level , it processes the acutal inserts one after another
        // milisec later 2 req tries to save the same key and schema has unique:true, mongoDB rejects with 11000 error code 
        // 11000 --->> duplicate key error 

        try{
            await newJob.save();
        }catch(dberror){
            if(dberror.code === 11000){
                const parallelExistingJob = await EmailJob.findOne({ idempotencyKey: idempotencyKey });
                return res.status(200).json({
                    success: true,
                    message: 'The work has already been done.',
                    // jobId:parallelExistingJob._id,
                })
            }
            throw dberror;
        }

        // the next part is for adding the job into the queue for processing by worker.js, 
        try{
            await emailQueue.add(
                'send-email',{
                    mongoId:newJob._id,
                    to:email,
                    subject:subject,
                    body:body,
                },
                {
                    jobId:idempotencyKey, // this is to ensure that if the same job is added again, it will not be added again to the queue
                    attempts:5,
                    backoff:{
                        type:'exponential',
                        delay:20000, // 20 seconds
                        jitter:0.5 
                    }
                }
            )
        }catch(error){ // if addin to queue fails 
            console.log('Error adding job to the queue:', error);
            newJob.status = 'failed';
            newJob.lastError = error.message || 'Unknown error';
            await newJob.save();
            return res.status(500).json({
                success: false,
                message: 'Failed to add email job to the queue',
                error:error.message,
            })
        }

        return res.status(202)
        .json({
            success: true,
            message: 'Email job added to the queue for processing',
            jobId:newJob._id,
        });
        // res.status(200).json({ message: 'Email sent successfully' });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ message: 'Error sending email' });
    }
})

app.get('/emails/failed', async(req,res)=>{
    try{
        const failedEmails = await EmailJob.find({ status: 'failed' }).sort({ updatedAt:-1});
        if(failedEmails.length === 0){
            return res.status(200).json({
                success: true,
                message: 'No failed emails found',
                failedEmails: [],
            })
        }

        return res.status(200).json({
            success: true,
            message: 'Failed emails retrieved successfully',
            failedEmails: failedEmails,
        })
    }catch(error){
        return res.status(500).json({
            success: false,
            message: 'Error retrieving failed emails',
            error: error.message,
        })
    }
})

app.post('/emails/retry/:jobId', async(req,res)=>{
    try{

        const { jobId } = req.params;
        const emailJob = await EmailJob.findById(jobId);
        if(!emailJob){
            return res.status(404).json({
                success: false,
                message: 'Email job not found',
            })
        }

        if(emailJob.status !== 'failed'){
            return res.status(400).json({
                success: false,
                message: 'Email job is not in failed status',
            })
        }

        emailJob.status = 'pending';  // here we are restting the old vlaues to make it a fresh job
        emailJob.lastError = undefined;
        emailJob.attempts = 0;
        await emailJob.save();

        await emailQueue.add(
            'send-email',{
                mongoId:emailJob._id,
                to:emailJob.to,
                subject:emailJob.subject,
                body:emailJob.body,
            },{
                jobId:`${emailJob.idempotencyKey}-retry-${Date.now()}`, // we here use a retry job new id so that redis treats this as new job
                attempts:5,
                backoff:{
                    type:'exponential',
                    delay:20000, // 20 seconds
                    jitter:0.5
                }
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Email job retried successfully',
            jobId:emailJob._id,
        })

    }catch(error){
        return res.status(500).json({
            success: false,
            message: 'Error retrying failed email',
            error: error.message,
        })
    }
})


export {app};