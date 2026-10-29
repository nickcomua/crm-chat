import { Runtime } from 'foldkit'

import { Model, subscriptions, update, view } from './main'
import { initPreview } from './preview'

const application = Runtime.makeApplication({
  Model,
  init: initPreview,
  update,
  subscriptions,
  view,
  container: document.getElementById('root'),
})

Runtime.run(application)
