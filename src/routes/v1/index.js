const express = require('express');
// Legacy auth and user routes removed - using Supabase authentication
// const authRoute = require('./auth.route');
// const userRoute = require('./user.route');
const chatRoute = require('./chat.route');
const messageRoute = require('./message.route');
const pdfRoute = require('./pdf.route');
const docsRoute = require('./docs.route');
const config = require('../../config/config');

const router = express.Router();

const defaultRoutes = [
  // Legacy auth and user routes removed - functionality moved to Supabase
  // {
  //   path: '/auth',
  //   route: authRoute,
  // },
  // {
  //   path: '/users',
  //   route: userRoute,
  // },
  {
    path: '/chat',
    route: chatRoute,
  },
  {
    path: '/message',
    route: messageRoute,
  },
  {
    path: '/pdf',
    route: pdfRoute,
  },
];

const devRoutes = [
  // routes available only in development mode
  {
    path: '/docs',
    route: docsRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

/* istanbul ignore next */
if (config.env === 'development') {
  devRoutes.forEach((route) => {
    router.use(route.path, route.route);
  });
}

module.exports = router;
