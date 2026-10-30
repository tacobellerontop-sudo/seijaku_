/* Seijaku reader view, parent side. Nothing to do here: the shell
   asks the child for the article with sendQuery and gets the answer
   back as the query's result. The class exists because a window
   actor needs a parent half to be reachable from the chrome window. */

export class SeijakuReaderParent extends JSWindowActorParent {}
