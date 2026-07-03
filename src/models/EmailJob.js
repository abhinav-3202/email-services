import mongoose,{Schema} from "mongoose";

const emailJobSchema = new Schema({
    to:{
        type:String,
        required:true,
        lowercase:true,
    },
    subject:{
        type:String,
        required:true,
    },
    body:{
        type:String,
        required:true,
    },
    status:{
        type:String,
        enum:["pending", "sent", "failed"],
        default:"pending",
    },
    attempts:{
        type:Number,
        default:0,
    },
    lastError:{
        type:String,
    },
    idempotencyKey:{
        type:String,
        required:true,
        unique:true,
    },
    providerMessageId:{
        type:String,
    },
},
    {
        timestamps:true,
    },
)

export const EmailJob = mongoose.model("EmailJob", emailJobSchema);