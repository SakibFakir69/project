import { MainServer } from "./index.js";

const start = async () => {
  try {
    const address = await MainServer.listen({
      port: Number(process.env.PORT) || 5000,
      host: "0.0.0.0"
    });

    console.log(`Server running at ${address}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
