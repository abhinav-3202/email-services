// code can be used in worker.js file

try{
            const emailResponse = await resend.emails.send({
                from: 'Acme <onboarding@resend.dev>',
                to: email,
                subject: subject,
                html:body
            });

            newJob.attempts += 1;

            if(emailResponse.data?.id){
                newJob.status = 'sent';
                await newJob.save();
                return res.status(200)
                .json({
                    success: true,
                    message: 'Email sent successfully',
                    jobId:newJob._id,
                })
            }else{
                newJob.status = 'failed';
                newJob.lastError = emailResponse.error?.message || 'Unknown provider error';
                await newJob.save();
                return res.status(400)
                .json({
                    success: false,
                    message: 'Email provider rejected request',
                    error:newJob.lastError,
                    jobId:newJob._id,
                })
            }

        }catch(error){
            newJob.attempts += 1;
            newJob.status = 'failed';
            newJob.lastError = error.message || 'Unknown provider error';
            await newJob.save();
            return res.status(500)
            .json({
                success: false,
                message: 'Failed to dispatch email execution',
                error:error.message,
            })
        }
