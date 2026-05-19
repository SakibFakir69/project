
import dotenv from "dotenv";
dotenv.config();
import fastify from "fastify";
import { downloadRoutes } from "./app/downloader/downloader.route.js";
import cors  from '@fastify/cors'
import { fastifyRateLimitMiddleware } from "./middleware/index.js";
import { initCookies } from "./utils/cookies.js";



initCookies();

const app = fastify({
  
  logger:true
})



await fastifyRateLimitMiddleware(app);


app.addHook("onRequest", (req,reply,done)=>{
  console.log(req.method);
  done();
  
})

app.register(cors,{
  origin:"*",
  methods:['POST','GET']
})

app.get("/", async (req, reply) => {
  return { message: "Hello World", time:process.uptime()  };
});

// ROUTES
app.register(downloadRoutes, {prefix:'/api/v1'})



// HEALTH CHECK
app.get('/home', (request,reply)=>{

  return {message:"Welome to authservices"}
})



// EXPORT APP
export const MainServer = app;
