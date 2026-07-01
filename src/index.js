import dotenv from 'dotenv';
import connectDB from './db/index.js';
import {app} from './server.js';

dotenv.config({path: './.env'}); //this is a mandatory stuff to load the environment variables from the .env file

connectDB()
.then(()=>{

    app.on("error",(error)=>{
        console.log('Error starting the server:', error);
        throw error;
    })
    app.listen(process.env.PORT || 3000,()=>{
        console.log('Server is running on port ' + (process.env.PORT || 3000));
    })
})
.catch((error)=>{
    console.error('Error connecting to the database:', error);
    process.exit(1);
})