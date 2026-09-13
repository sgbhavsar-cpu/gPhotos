can we use one drive or google drive directly as network storage source so that without download we can create virtual albums, also let me know why there is two buttons for scanning photo and scanning faces, if we are scanning remote drive for thumbnail, in same pass we should recognize faces and in case remote storage is not available, thumbnail should be used to show the people album.


when we are doing brackground scanning using network storage, sometime it utilize whole bandwidth, can we add settings 
- Maximum bandwidth user per network storage
- Time duration in second between two photo processing

This would help to make evyething responsive and if user working on his desktop, his network storage used for other purpose do not feel slow.

<
need rotate button on photo - list of photo screen on hover of mouse like checkbox for selection appears, When click rotate it should roate thumbnail shown on screen and wait for 2 second so may be user rotate it multiple time, after wait of 2 second, it should be implemented on source file if online and if offline, it has to queue that for when source become online.

also notice 40 second of time required to start the application which is too high, check and improve it by differing un-necessory tasks 


Additionally, if I am having 2871 photo in physical folder, face scanning should run on that only but I am observing that it is showing almost double, are face scanning run on thumbnail ? it should run on original picture, for ehic it should generate full resolution jpeg file, run the face recognition and then delete it, for showing to user it should use thumbnail or original photo if storage is available.

In network storage screen, each configured storage should clearly show the progress or status of caching of thumbnail and face detection count. right now jainish is showing face detection status but not thumbnail status and photo1 shows nothing.

Loosing people name is crime as user has done manual input for that so do not loose names anyhow until user click on button reset and rescan.

I recommend to remove overall caching progress section and show that into individual configured storage section only that would serve the purpose .
==

When open network storage it shows nothing configured and then slowely update with actual data, rather than show nothing configured, we should show 'Loading info' until info is actually loaded.

For heic images, we should enable rotate functionality and rorate only thumbnail what we have in our folder to show it properly to user, when user clicks on image and original image is loaded, it might be seen original but that works for now.

Deduplication from selected images, it should treat it as like one cluster and then try to identify best shot between selected images. 

Review all code base.
- Check for error handling
- Best code practices
- Improvement for speed and responsiveness to user.
- Keep everything updated and stored whenever some progress is done.
- vusal styling consistant
- Show un-initialized or never loaded info as default stuff, rather should show 'Loading...' or some animation until info is actually loaded.   




