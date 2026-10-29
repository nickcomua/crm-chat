import { Runtime } from 'foldkit'

import { Model, init, subscriptions, update, view } from './main'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  subscriptions,
  view,
  container: document.getElementById('root'),
})

Runtime.run(application)
