import express from 'express';
// import cors from 'cors';
import dotenv from 'dotenv';
import { resend } from './lib/resend.js';

dotenv.config({path: './.env'});

const app = express();
app.use(express.json());

app.post('/emails', async (req,res)=>{
    try{
        const { email, subject, body } = req.body;
        await resend.emails.send({
            from: 'Acme <onboarding@resend.dev>',
            to: email,
            subject: subject,
            html:body
        })
        res.status(200).json({ message: 'Email sent successfully' });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ message: 'Error sending email' });
    }
})


export {app};