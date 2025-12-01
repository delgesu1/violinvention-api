const express = require('express');
const helmet = require('helmet');
const xss = require('xss-clean');
const compression = require('compression');
const cors = require('cors');
// Removed passport - using Supabase authentication
// const passport = require('passport');
const httpStatus = require('http-status');
const config = require('./config/config');
const morgan = require('./config/morgan');
// Removed JWT strategy - using Supabase authentication
// const { jwtStrategy } = require('./config/passport');
const { authLimiter } = require('./middlewares/rateLimiter');
const routes = require('./routes/v1');
const { errorConverter, errorHandler } = require('./middlewares/error');
const ApiError = require('./utils/ApiError');
const path = require('path');

const app = express();

if (config.env !== 'test') {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// set security HTTP headers
app.use(helmet());

// Stripe webhook needs raw body for signature verification
// Must come BEFORE express.json()
app.use('/v1/billing/webhook', express.raw({ type: 'application/json' }));

// parse json request body (skip for webhook which uses raw)
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// sanitize request data
app.use(xss());

// gzip compression
app.use(compression({
  filter: (req, res)=>{
    if (req.headers['x-no-compression']) {
      // don't compress responses with this request header
      return false
    }

    // fallback to standard filter function
    return compression.filter(req, res)
  }
}));

// enable cors
app.use(cors());
app.options('*', cors());

// Legacy JWT authentication removed - using Supabase authentication
// app.use(passport.initialize());
// passport.use('jwt', jwtStrategy);

// Legacy auth rate limiting removed (no /v1/auth endpoints)
// if (config.env === 'production') {
//   app.use('/v1/auth', authLimiter);
// }

// v1 api routes
app.use('/v1', routes);

// send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, 'Not found (route doesnt exist)'));
});

// convert error to ApiError, if needed
app.use(errorConverter);

// handle error
app.use(errorHandler);

module.exports = app;
