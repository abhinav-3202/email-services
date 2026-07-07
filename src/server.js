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
                        delay:2000, // 20 seconds
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
                    delay:2000, // 20 seconds
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

app.get('/emails/stats', async (req, res) => {
    try {
        const stats = await EmailJob.aggregate([
            {
                $facet: {//allows to run multiple independent aggregation pipelines in parallel on same set of documents
                    // Branch 1: Group and count jobs by their current status
                    statusCounts: [
                        {
                            $group: {// combine multiple documents into single based on sepcified identifier 
                                _id: "$status",// identifier
                                count: { $sum: 1 } // instead use count: {$count:{}}
                            } // by documentation , 2nd one is easy 
                        }
                    ],
                    // Branch 2: Calculate global summary metrics across the whole collection
                    globalMetrics: [
                        {
                            $group: {
                                _id: null,
                                totalJobs: { $count:{}}, // instead we can use 
                                avgAttempts: { $avg: "$attempts" }
                            }
                        }
                    ]
                }
            },
            {
                // Stage 2: Reshape the output so it looks like a clean API response
                $project: {
                    totalJobs: { 
                        $ifNull: [ { $arrayElemAt: ["$globalMetrics.totalJobs", 0] }, 0 ] 
                    },
                    averageAttempts: { 
                        $round: [ { $ifNull: [ { $arrayElemAt: ["$globalMetrics.avgAttempts", 0] }, 0 ] }, 2 ] 
                    },
                    statuses: "$statusCounts"
                }
            }
        ]);

        // Reason why used avg attempts is beacuse :
        // 1. total emails: 10000 failed :0 , avg attempts:1
        // 2. total emails: 10000 failed :0 , avg attempts:4.2
        // in both cases , the emails are sent successfully but in 2nd case, further checking is needed because it is close to our upper lomit of 5 

        // MongoDB aggregation always returns an array, extract our single results object
        const result = stats[0] || { totalJobs: 0, averageAttempts: 0, statuses: [] };

        // Convert the statuses array into a clean key-value object (e.g., { pending: 5, sent: 20 })
        const formattedStatuses = { pending: 0, sent: 0, failed: 0 };
        result.statuses.forEach(item => {
            if (item._id) formattedStatuses[item._id] = item.count;
        });

        return res.status(200).json({
            success: true,
            data: {
                totalJobs: result.totalJobs,
                averageAttempts: result.averageAttempts,
                statusCounts: formattedStatuses
            }
        });

    } catch (error) {
        console.error('Failed to fetch system stats:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/webhooks/resend',async(req,res)=>{

    try{
        const payload = JSON.stringify(req.body);
        let event;
        // console.log('Received webhook event:', payload);
        try{
            event = resend.webhooks.verify({
                payload,
                headers:{
                    'svix-id':req.headers['svix-id'],
                    'svix-timestamp':req.headers['svix-timestamp'],
                    'svix-signature':req.headers['svix-signature'],
                },
                secret:process.env.RESEND_WEBHOOK_SECRET,
            })
            // console.log(event.data.secret,process.env.RESEND_WEBHOOK_SECRET);
            console.log('the secret is :',event.data.secret);
        }catch(error){
                console.log('Webhook verification failed:', error);
                return res.status(400).
                        json({ message: 'Webhook verification failed' });
        }

        const {type, data} = event;

        const providerMessageId = data?.id || data?.email_id;

        if(!providerMessageId){
            console.log('Missing providerMessageId in webhook event data');
            return res
            .status(400)
            .json({ message: 'Missing providerMessageId in webhook event data' });
        }

        const emailJob = await EmailJob.findOne({providerMessageId});
        if(!emailJob){
            console.log('Email job not found for providerMessageId:', providerMessageId);
            return res
            .status(404)
            .json({ message: 'Email job not found for providerMessageId' });
        }

        switch(type){
            case 'email.delivered':
                emailJob.status = 'delivered';
                break;
            case 'email.bounced':
                emailJob.status = 'failed';
                emailJob.lastError = data?.reason || 'Unknown provider error';
                break;
            case 'email.complained':
                emailJob.status = 'failed';
                emailJob.lastError = data?.reason || 'Unknown provider error';
                break;
            default:// for any other event lie email.opened , email.clicked etc ,so if we keep status as 400 it will retry after some attempts 
                console.log('Unhandled webhook event type:', type);
                return res
                .status(200)
                .json({ message: 'Unhandled webhook event type' });
        }

        await emailJob.save();
        return res
        .status(200)
        .json({ message: 'Webhook processed successfully' });

    }catch(error){
        console.error('Error processing webhook:', error);
        return res
        .status(500)
        .json({ message: 'Error processing webhook' });
    }

})
export {app};