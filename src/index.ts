import express from 'express';
import { config } from './config';
import { handleReservationWebhook, startScheduler, getScheduleState, scanReservations } from './scheduler';
import { sendAlert } from './alerts';

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  const schedule = getScheduleState();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    schedule: {
      pending: schedule.pending.length,
      executed: schedule.executed.length,
    },
  });
});

// Hostaway webhook: reservation.created / reservation.updated
app.post('/webhook/hostaway', async (req, res) => {
  try {
    const { event, data } = req.body;

    if (event === 'reservation.created' || event === 'reservation.updated') {
      console.log(`[Webhook] ${event} — reservation ${data?.id}`);
      await handleReservationWebhook(data);
    }

    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`Webhook error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger: scan reservations now
app.post('/scan', async (_req, res) => {
  try {
    await scanReservations();
    res.json({ status: 'scan complete', schedule: getScheduleState() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// View current schedule
app.get('/schedule', (_req, res) => {
  res.json(getScheduleState());
});

// Start
app.listen(config.server.port, async () => {
  console.log(`Pool Heat Manager running on port ${config.server.port}`);
  startScheduler();

  await sendAlert('info', 'Pool Heat Manager started', `Server is running on port ${config.server.port}`);
});
