###
  Animator

  Handles animation of a given set of values.

  @param datafeed A function which takes no parameters and
                  returns an object with the following properties:
                    - values: An array of values a given time. Each value
                              will be animated between after each call to the function.
                              e.g. values: [xCoord, yCoord, zCoord]
                    - timeElapsed: The number of milliseconds that had elapsed when the
                                   given values were taken.
                  If the function returns false, animation ends.
  @param drawer   A function which takes an object with the same properties as the datafeed
                  plus a current timestamp and a boolean representing whether the given
                  points are feed values (true) or tween values (false), in order to
                  distinguish between the real data. Returns as a parameter and the time
                  elapsed as another and returns nothing.
  @param autostart A boolean as to whether animation should begin as soon as the constructor
                   finishes. Default true
  @param speed     A number representing the speed that the animation should run at. Lower than
                   1 will run the animation in slow motion. Default 1.
###
class Animator
  constructor: (@datafeed, @drawer, @autostart = true, @speed = 1) ->
    if not @datafeed? or not @drawer?
      console.error "A datafeed and drawer function must be specified."
      return false
    # Collect all the browser prefixed versions into one variable
    @raf = window.requestAnimationFrame.bind(window) || window.mozRequestAnimationFrame.bind(window) || window.webkitRequestAnimationFrame.bind(window) || window.msRequestAnimationFrame.bind(window)
    @oldData = {values: [], time: -1, event: "none", key: {}}
    #@oldData = @datafeed()
    @curData = {values: [], time: -1, event: "none", key: {}}
    @newData = {values: [], time: -1, event: "none", key: {}}
    @realTime = new Date().getTime()
    @timeElapsed = 0;
    if @autostart
      @start()
    else
      @stop()

  animate: (lastAnimTime) ->
    #console.log lastAnimTime
    # Get the current time
    time = @currentTimeElapsed()

    # Get the difference between the time last animated and now
    timeDiff = time - lastAnimTime

    # Get the new log of data if required
    if @newData.time < time
      console.log((@newData.time - time) / timeDiff)
      @oldData = @newData
      @curData = @oldData
      @newData = @datafeed()
      console.log(@oldData, @newData, (@newData.time - time) / timeDiff)
      if @newData is false
        @stop()

    # Check to see if the animation is still running.
    if @running
      # Run through each value, find the number of frames left and calculate the required change this time round
      i = 0
      timeLeft = (@newData.time - time)  / timeDiff # The number of frames left to complete the transition
      for val in @newData.values
        oldVal = (@curData.values[i]||0)
        dist = val - oldVal
        valChange = dist / timeLeft
        @curData.values[i] = oldVal + valChange
        i++

      # Pass the time difference to the drawer
      keyFrame = if timeLeft <= 0 then true else false
      @drawer @curData, time, keyFrame

      # Request a new frame and call this function again
      @raf(@animate.bind(this, time))
      true
    else
      false

  currentTimeElapsed: ->
    newTimeElapsed = new Date().getTime() - @startTime
    oldTimeElapsed = @realTime - @startTime
    @realTime = new Date().getTime()
    timeDiff = newTimeElapsed - oldTimeElapsed
    @timeElapsed += timeDiff * @speed
    @timeElapsed


  start: ->
    @running = true
    @startTime = new Date().getTime()
    @animate @currentTimeElapsed()
    true

  stop: ->
    @running = false
    true