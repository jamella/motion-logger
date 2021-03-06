#!/usr/bin/env node

/**
 * The Keypress Learner takes data from the test data in the database, normalises it and trains multiple
 * neural networks with the data.
 *
 * This should probably be reorganises into a transform stream for normalisation and a learner controller.
 *
 * Created by Andrew Bridge on 16/02/2015.
 */

//Shim for Promises
if (typeof Promise == "undefined") {Promise = require("promise");}

var lib = require('../common.js'); // Common functions
var fs = require('fs'); // FileSystem
var config = lib.loadConfigs("../detector-config.json", "./config.json"); //Load in global and local configs
var save = require('save'); //Database interface
var saveMongodb = require('save-mongodb');
var Db = require('mongodb').Db; //MongoDB Database object
var DbServer = require('mongodb').Server; //MongoDB Server object
var learner = require('../learners.js')('brain'); //Neural Network;
var currentRecord = 0;
var cache = {oBeta: {prePress: [], postPress: []}, oGamma: {prePress: [], postPress: []}, aZY: {prePress: [], postPress: []}};
var networks = {oBeta: {
    pre: learner.newLearner(),
    post: learner.newLearner()
}, oGamma: {
    pre: learner.newLearner(),
    post: learner.newLearner()
}, aZY: {
    pre: learner.newLearner(),
    post: learner.newLearner()
}
};
var downUpDiff = []; // Min and Max difference between keydown and keyup events.
var promExtractor = function(resolve, reject) {this.resolve = resolve; this.reject = reject;};

var subjSaveDb = new Db('TestSubjects', new DbServer('localhost', 27017, {})) //Initialisation of the TestSubjects database
    , subjCol; //Initialising db interface object

var testProm = {};
var testDone = new Promise(promExtractor.bind(testProm));

subjSaveDb.open(function (error, connection) {
    if (error) {
        testProm.reject("Error opening TestSubjects database! " + JSON.stringify(error.errors));
        return false;
    }

    connection.collection('sessions', function (error, collection) {
        if (error) {
            testProm.reject("Error choosing TestSubjects collection! " + JSON.stringify(error.errors));
            return false;
        }
        console.log("Chosen TestSubjects collection, successful connection...");
        subjCol = save('TestSessions', {engine: saveMongodb(collection)});
        testProm.resolve();
    });
});

Promise.all([testDone]).then(finishSetup, function() {
    console.log("ERROR: An error occurred opening the databases.");
    throw new Error("An error occurred opening the databases.");
});

function finishSetup() {
    subjCol.count({}, function(cnterr, data) {
        if (cnterr) {return new Error("There was an error counting the data items.");}
        if (data > currentRecord) {
            subjCol.find({}, function(findErr, data) {
                if (findErr) {return new Error("There was an error choosing a data item.");}
                try {
                    console.log("Attempting to select record for learning. Trying record: "+currentRecord);
                    var finalData = data[currentRecord].data;
                    console.log("Selection and parsing successful. Sending for prep.");
                    currentRecord++;
                    learn(finalData);
                } catch (e) {
                    return new Error("There was an error parsing the test data.");
                }
            });
        } else {
            console.log("Beginning to train networks.");
            for (var measure in networks) {
                if (networks.hasOwnProperty(measure)) {
                    console.log("Training for "+measure);

                    console.log(networks[measure].pre.train(cache[measure].prePress, {log: true}));
                    console.log(networks[measure].post.train(cache[measure].postPress, {log: true}));
                }
            }
            var dataObj = {
                downUpRange: JSON.stringify(downUpDiff),
                oBetaPrePress: networks.oBeta.pre.toJSON(),
                oBetaPostPress: networks.oBeta.post.toJSON(),
                oGammaPrePress: networks.oGamma.pre.toJSON(),
                oGammaPostPress: networks.oGamma.post.toJSON(),
                aZYPrePress: networks.aZY.pre.toJSON(),
                aZYPostPress: networks.aZY.post.toJSON()
            };
            fs.writeFile("./keypress_detection_data.json", JSON.stringify(dataObj), function(err) {
                if (err) {
                    console.log("An issue occurred saving the detection data.");
                } else {
                    console.log("Detection data saved.");
                }
                console.log("Finished learning!");
                process.exit(0);
            });
        }
    });
}

//This function takes the first index of an array as an origin and finds the differences for each index afterwards.
//It then uses the maxRange to calculate the difference as a percentage of the maxRange if it's given.
function normaliseArrData(arr, maxRange) {
    maxRange = (typeof maxRange == "undefined") ? 100 : maxRange;
    if (arr.length > 0) {
        var origin = arr[0];
        var len = arr.length;
        for (var i = 0; i < len; i++) {
            arr[i] = ((arr[i]-origin)/maxRange);
        }
    }

    return arr;
}

function findRange(arr, retArr) {
    var maxMin = [0,0];
    var len = arr.length;
    for (var i = 0; i < len; i++) {
        var datum = arr[i];
        maxMin[0] = (datum < maxMin[0]) ? datum : maxMin[0];
        maxMin[1] = (datum > maxMin[1]) ? datum : maxMin[1];
    }
    return (retArr) ? maxMin : Math.abs(maxMin[1]-maxMin[0]);
}

function arrToBrainFormat(outputVal, val) {
    return {input: val, output: outputVal};
}

function splitArr(arr, splitStart, splitEnd) {
    var front = arr.slice(0,splitStart);
    var back = arr.slice(splitEnd+1);
    return [front, back];
}

function pruneArr(arr, limit) {
    var ret = [];
    for (var i = 0; i < arr.length; i++) {
        var ar = arr[i].slice(0); //Take a copy
        while (ar.length >= limit) {
            ret.push(ar.splice(0,limit));
        }
    }
    return ret;
}

function learn(dataArr) {
    console.log("Beginning prep...");
    var stream = require("./clouded-sky.js").init(dataArr);
    var datapoint;
    var exit = false;
    var hasPress = false;
    var firstResponseThreshold = config.firstResponseThreshold; //Wait a second and a quarter before assuming a dud dataset.
    var trailLen = config.trailLength;
    var trailCountDown = NaN, touchFlag = NaN;
    var trailAcceptanceThreshold = config.trailAcceptanceThreshold; // The smallest range that should be exhibited in a trail for it to be included.
    var postTrailArr;
    // The ranges that each value could exhibit.
    // aZ and aY are estimations based on testing and the fact that acceleration of gravity is 9.82m/s
    var ranges = config.sensorRanges;
    var oBeta = {pings: [], prePress: [], postPress: [], noise: [[]]};
    var oGamma = {pings: [], prePress: [], postPress: [], noise: [[]]};
    var aZY = {pings: [], prePress: [], postPress: [], noise: [[]]};
    // pings - All the pings in the dataset
    // prePress - Contains arrays of [trailLen] pings before each keydown (keydown is included too, making [trailLen+1] values)
    // postPress - Contains arrays of [trailLen] pings after each keyup (keyup is included too, making [trailLen+1] values)
    var downTime;
    var count = 0;
    var strmLen = stream.store.length;
    while((datapoint = stream.pick(0)[0]) && !exit) {
        count++;
        if (Boolean(process.stdout.isTTY)) {
            process.stdout.write("Prepping datapoint "+count+" of "+strmLen+": Type: "+datapoint.data.event);
        } else {
            console.log("Prepping datapoint "+count+" of "+strmLen+": Type: "+datapoint.data.event);
        }
        switch(datapoint.data.event) {
            case "ping":
                if (datapoint.time > firstResponseThreshold && (!datapoint.data.datapoints.orientation.x || !datapoint.data.datapoints.orientation.y
                    || !datapoint.data.datapoints.acceleration.z || !datapoint.data.datapoints.acceleration.y)) {
                    exit = true;
                } else if ((datapoint.data.datapoints.orientation.x && datapoint.data.datapoints.orientation.y
                    && datapoint.data.datapoints.acceleration.z && datapoint.data.datapoints.acceleration.y)) {
                    oBeta.pings.push(datapoint.data.datapoints.orientation.x);
                    oGamma.pings.push(datapoint.data.datapoints.orientation.y);
                    aZY.pings.push(lib.getVectorMagnitude(datapoint.data.datapoints.acceleration.z, datapoint.data.datapoints.acceleration.y));
                    oBeta.noise[oBeta.noise.length-1].push(datapoint.data.datapoints.orientation.x);
                    oGamma.noise[oGamma.noise.length-1].push(datapoint.data.datapoints.orientation.y);
                    aZY.noise[aZY.noise.length-1].push(lib.getVectorMagnitude(datapoint.data.datapoints.acceleration.z, datapoint.data.datapoints.acceleration.y));
                    if (!isNaN(trailCountDown) && typeof postTrailArr != "undefined") {
                        if (trailCountDown == 0) {
                            trailCountDown = NaN;
                            var oBetaTrail = normaliseArrData([postTrailArr.oBeta].concat(oBeta.pings.slice(oBeta.pings.length-trailLen, oBeta.pings.length)), ranges.oBeta);
                            if (findRange(oBetaTrail) != trailAcceptanceThreshold) {oBeta.postPress.push(oBetaTrail);}
                            var oGammaTrail = normaliseArrData([postTrailArr.oGamma].concat(oGamma.pings.slice(oGamma.pings.length-trailLen, oGamma.pings.length)), ranges.oGamma);
                            if (findRange(oGammaTrail) != trailAcceptanceThreshold) {oGamma.postPress.push(oGammaTrail);}
                            var aZYTrail = normaliseArrData([postTrailArr.aZY].concat(aZY.pings.slice(aZY.pings.length-trailLen, aZY.pings.length)), ranges.aZY);
                            if (findRange(aZYTrail) != trailAcceptanceThreshold) {aZY.postPress.push(aZYTrail);}
                            postTrailArr = undefined;
                        } else {
                            trailCountDown--;
                        }
                    }
                    if (!isNaN(touchFlag)) {
                        if (touchFlag == 0) {
                            oBeta.noise.splice.apply(oBeta.noise, [oBeta.noise.length-1, 1].concat(splitArr(oBeta.noise[oBeta.noise.length-1], oBeta.noise[oBeta.noise.length-1].length-trailLen+2, oBeta.noise[oBeta.noise.length-1].length)));
                            oGamma.noise.splice.apply(oGamma.noise, [oGamma.noise.length-1, 1].concat(splitArr(oGamma.noise[oGamma.noise.length-1], oGamma.noise[oGamma.noise.length-1].length-trailLen+2, oGamma.noise[oGamma.noise.length-1].length)));
                            aZY.noise.splice.apply(aZY.noise, [aZY.noise.length-1, 1].concat(splitArr(aZY.noise[aZY.noise.length-1], aZY.noise[aZY.noise.length-1].length-trailLen+2, aZY.noise[aZY.noise.length-1].length)));
                        } else {
                            touchFlag--;
                        }
                    }
                }
                break;
            case "keydown":
                if (oBeta.pings.length >= trailLen) {
                    hasPress = true;
                    //Only add data if it has a change above the trail acceptance threshold.
                    var oBetaTrail = normaliseArrData(oBeta.pings.slice(oBeta.pings.length-trailLen, oBeta.pings.length).concat(datapoint.data.datapoints.orientation.x), ranges.oBeta);
                    if (findRange(oBetaTrail) != trailAcceptanceThreshold) {oBeta.prePress.push(oBetaTrail);}
                    var oGammaTrail = normaliseArrData(oGamma.pings.slice(oGamma.pings.length-trailLen, oGamma.pings.length).concat(datapoint.data.datapoints.orientation.y), ranges.oGamma);
                    if (findRange(oGammaTrail) != trailAcceptanceThreshold) {oGamma.prePress.push(oGammaTrail);}
                    var aZYTrail = normaliseArrData(aZY.pings.slice(aZY.pings.length-trailLen, aZY.pings.length).concat(lib.getVectorMagnitude(datapoint.data.datapoints.acceleration.z, datapoint.data.datapoints.acceleration.y)), ranges.aZY);
                    if (findRange(aZYTrail) != trailAcceptanceThreshold) {aZY.prePress.push(aZYTrail);}
                    downTime = datapoint.time;
                }
                break;
            case "keyup":
                //downTime is only set if there are enough pings
                if (typeof downTime == "number") {
                    trailCountDown = trailLen-1;
                    var timeDiff = datapoint.time - downTime;
                    downUpDiff[0] = (timeDiff < downUpDiff[0] || typeof downUpDiff[0] == "undefined") ? timeDiff : downUpDiff[0];
                    downUpDiff[1] = (timeDiff < downUpDiff[1] || typeof downUpDiff[1] == "undefined") ? timeDiff : downUpDiff[1];
                    postTrailArr = {oBeta: datapoint.data.datapoints.orientation.x, oGamma: datapoint.data.datapoints.orientation.y,
                                    aZY: lib.getVectorMagnitude(datapoint.data.datapoints.acceleration.z, datapoint.data.datapoints.acceleration.y)};
                }
                break;
            case "touchend":
                //Flag a touch event so it can be removed from the noise data
                touchFlag = 4;
                break;
        }
        if (!stream.isEmpty()) {
            process.stdout.clearLine();  // clear current text
            process.stdout.cursorTo(0);  // return cursor
        } else {
            process.stdout.write("\n");
        }
    }
    if (!exit && hasPress) {
        console.log("Prep complete!");
        var data = {oBeta: {}, oGamma: {}, aZY: {}};
        console.log("Formatting");
        data.oBeta.prePress = oBeta.prePress.map(arrToBrainFormat.bind(this, {keypress: 1})).concat(pruneArr(oBeta, trailLen+1).map(arrToBrainFormat.bind(this, {keypress: 0})));
        data.oBeta.postPress = oBeta.postPress.map(arrToBrainFormat.bind(this, {keypress: 1})).concat(pruneArr(oBeta, trailLen+1).map(arrToBrainFormat.bind(this, {keypress: 0})));
        data.oGamma.prePress = oGamma.prePress.map(arrToBrainFormat.bind(this, {keypress: 1})).concat(pruneArr(oGamma, trailLen+1).map(arrToBrainFormat.bind(this, {keypress: 0})));
        data.oGamma.postPress = oGamma.postPress.map(arrToBrainFormat.bind(this, {keypress: 1})).concat(pruneArr(oGamma, trailLen+1).map(arrToBrainFormat.bind(this, {keypress: 0})));
        data.aZY.prePress = aZY.prePress.map(arrToBrainFormat.bind(this, {keypress: 1})).concat(pruneArr(aZY, trailLen+1).map(arrToBrainFormat.bind(this, {keypress: 0})));
        data.aZY.postPress = aZY.postPress.map(arrToBrainFormat.bind(this, {keypress: 1})).concat(pruneArr(aZY, trailLen+1).map(arrToBrainFormat.bind(this, {keypress: 0})));

        console.log("Adding to data cache");
        for (var measure in cache) {
            if (cache.hasOwnProperty(measure)) {
                console.log("Adding to "+measure);

                cache[measure].prePress = cache[measure].prePress.concat(data[measure].prePress);
                cache[measure].postPress = cache[measure].postPress.concat(data[measure].postPress);
            }
        }

    } else {
        console.log("This set of data exited early. Current record: "+currentRecord);
    }
    finishSetup();
    // TODO: Basically repeat but for quadrants (need to loop through data and split data into quadrants) (not here, separate)
}
